import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TabRef } from "@ai-browser/shared";
import { CommandBar, type CommandBarHandle } from "../src/ui/CommandBar";
import { createCommandController, initialBarState, type BarState, type BarView, type CommandHost } from "../src/ui/command";

// Every string a reply carries is drawn as a text node, never as HTML (shared-command-types rule 1). These tests
// push markup through every view of the bar and check it comes out escaped, and that nothing in the bar can make
// a link or an image.
const EVIL = '<img src=x onerror="alert(1)"><script>alert(2)</script><a href="https://evil.example">click</a>';
const ESCAPED = "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;";

const host: CommandHost = {
  surface: "home",
  getContext: async () => ({ surface: "home", timeZone: "UTC", expandedWorkspaceIds: [], activeTab: null, windowTabIds: [] }),
  refresh: () => undefined,
  showHome: async () => undefined,
  openTab: async () => undefined,
  scanDuplicates: async () => ({ groups: [], totalToClose: 0 }),
  closeDuplicates: async () => ({ closed: 0, skipped: 0 }),
};
const tabRef = (title: string): TabRef => ({ id: "t-1", userId: "u", workspaceId: null, url: "https://example.com/a", title, snippet: "", chromeTabId: 1, lastSeenAt: "2026-09-20T00:00:00Z", placementSource: null });

const render = (view: BarView, over: Partial<BarState> = {}) => {
  const state: BarState = { ...initialBarState, open: true, text: EVIL, view, ...over };
  const bar: CommandBarHandle = { controller: createCommandController({ config: null, host }), state, host };
  return renderToStaticMarkup(createElement(CommandBar, { bar }));
};

const VIEWS: [string, BarView][] = [
  ["say", { kind: "say", message: EVIL, help: [EVIL] }],
  ["ask", { kind: "ask", question: EVIL, choices: [{ label: EVIL, step: { kind: "submit", text: EVIL } }] }],
  ["running", { kind: "running", understood: EVIL }],
  ["confirming", { kind: "confirming", understood: EVIL, action: { type: "merge", fromWorkspaceId: "a", intoWorkspaceId: "b" }, preview: { title: EVIL, lines: [{ tabRefId: "t", title: EVIL, from: EVIL, to: EVIL }], hiddenCount: 3 } }],
  ["done", { kind: "done", message: EVIL, workspace: { id: "w", name: EVIL } }],
  ["failed", { kind: "failed", message: EVIL }],
  ["found", { kind: "found", understood: EVIL, tabs: [{ tab: tabRef(EVIL), workspaceName: EVIL }], workspaces: [{ workspace: { id: "w", userId: "u", name: EVIL, emoji: null, status: "active", createdAt: "", updatedAt: "" }, tabCount: 2 }], more: 2, cutNote: EVIL }],
  ["recalled", { kind: "recalled", understood: EVIL, periodLabel: EVIL, workspaces: [{ workspaceId: "w", name: EVIL, linkable: true, visits: 3, tabs: [{ title: EVIL, url: "https://example.com/a", visits: 3 }] }] }],
  ["agent", { kind: "agent", understood: EVIL, workspaceId: "w", phase: "result", lines: [EVIL], message: EVIL }],
  ["duplicates", { kind: "duplicates", plan: { groups: [{ url: "https://example.com/a", title: EVIL, keep: 1, close: [2] }], totalToClose: 1 }, closing: false }],
];

describe("everything a reply carries is drawn as escaped text", () => {
  it.each(VIEWS)("%s view", (_name, view) => {
    const html = render(view);
    expect(html).toContain(ESCAPED);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<a[\s>]/);
    // No real tag carries a link, a source, or an event attribute. (The markup appears only as escaped TEXT, which
    // is why a bare "href=" can occur: inside `&lt;a href=&quot;...`. A tag is what starts with a real `<`.)
    // Quoted attribute values are blanked first: the typed text is a (escaped) value="..." on the input, and it may
    // contain the words "src=" without being an attribute.
    const tags = html.replace(/"[^"]*"/g, '""');
    expect(tags).not.toMatch(/<[a-z][^>]*\s(?:href|src|srcset|action|formaction|on[a-z]+)\s*=/i);
  });

  it("the typed text is a value, and examples are buttons", () => {
    const html = render({ kind: "idle" });
    expect(html).toContain('value="&lt;img');
    expect(html).toContain("organize my tabs");
    expect(html).toContain("what was I working on yesterday?");
    expect(html.match(/class="cmd-ex"/g)).toHaveLength(6);
  });

  it("renders nothing while closed", () => {
    expect(render({ kind: "idle" }, { open: false })).toBe("");
  });

  it("shows the Undo control whenever there is something to undo and the bar is not busy", () => {
    const undo = { kind: "move" as const, summary: `moved 3 tabs to ${EVIL}`, expiresAt: "e" };
    expect(render({ kind: "idle" }, { undo })).toContain("Undo: moved 3 tabs to");
    expect(render({ kind: "idle" }, { undo })).toContain(ESCAPED);
    expect(render({ kind: "interpreting" }, { undo })).not.toContain("Undo:");
  });

  it("disables the box while a command runs, and shows the confirm and cancel buttons for a preview", () => {
    expect(render({ kind: "interpreting" })).toMatch(/<input[^>]*disabled/);
    const confirming = render(VIEWS.find(([n]) => n === "confirming")![1]);
    expect(confirming).toContain(">confirm<");
    expect(confirming).toContain(">cancel<");
    expect(confirming).toContain("and 3 more");
    expect(confirming).toContain("Nothing is deleted."); // a merge says so
  });

  it("says closing duplicate tabs cannot be undone", () => {
    expect(render(VIEWS.find(([n]) => n === "duplicates")![1])).toContain("Closing tabs can&#x27;t be undone.");
  });

  it("says how many more tabs matched, and offers each tab as a button (never a link)", () => {
    const html = render(VIEWS.find(([n]) => n === "found")![1]);
    expect(html).toContain("and 2 more");
    expect(html).toMatch(/<button[^>]*class="cmd-choice"[^>]*title="https:\/\/example.com\/a"/);
  });
});

describe("inline (Home's URL bar)", () => {
  const renderInline = (view: BarView, over: Partial<BarState> = {}) => {
    const state: BarState = { ...initialBarState, ...over, view };
    const bar: CommandBarHandle = { controller: createCommandController({ config: null, host }), state, host };
    return renderToStaticMarkup(createElement(CommandBar, { bar, variant: "inline", inputClassName: "url-bar" }));
  };

  it("always draws the URL bar as the command box, with nothing dropped down while closed", () => {
    const html = renderInline({ kind: "idle" }, { open: false });
    expect(html).toMatch(/<input[^>]*class="url-bar"[^>]*aria-label="command"/);
    expect(html).not.toContain("cmd-drop");
    expect(html).not.toContain("cmd-backdrop");
    expect(html).not.toContain("cmd-ex");
  });

  it("drops the examples down under the box when open, with no dialog or backdrop", () => {
    const html = renderInline({ kind: "idle" }, { open: true });
    expect(html).toContain("cmd-drop");
    expect(html).not.toContain("cmd-backdrop");
    expect(html).not.toContain('aria-modal');
    expect(html.match(/class="cmd-ex"/g)).toHaveLength(6);
  });

  it.each(VIEWS)("draws the %s view as escaped text, the same as the overlay", (_name, view) => {
    const html = renderInline(view, { open: true, text: EVIL });
    expect(html).toContain(ESCAPED);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<a[\s>]/);
  });

  it("disables the box while a command runs and keeps the Undo control", () => {
    expect(renderInline({ kind: "interpreting" }, { open: true })).toMatch(/<input[^>]*disabled/);
    const undo = { kind: "move" as const, summary: "moved 3 tabs", expiresAt: "e" };
    expect(renderInline({ kind: "idle" }, { open: true, undo })).toContain("Undo: moved 3 tabs");
  });
});

describe("the bar's source cannot make HTML", () => {
  const source = readFileSync(join(__dirname, "..", "src", "ui", "CommandBar.tsx"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}|\/\/.*$/gm, "");
  it.each(["dangerouslySetInnerHTML", "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "<a ", "<img", "href=", "src="])("does not contain %s", (needle) => {
    expect(code).not.toContain(needle);
  });
});
