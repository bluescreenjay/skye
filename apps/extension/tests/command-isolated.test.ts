import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CommandBarBoundary } from "../src/ui/CommandBar";

// The command bar must never be something the rest of the product depends on (spec FR-024, SC-013):
// Home's organize button, the five agents, and the Side Panel keep working when the bar is closed, absent,
// or broken. These checks make that a fact about the code, not a hope.
const SRC = join(__dirname, "..", "src");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");
const importsOf = (source: string) => [...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
const mentionsBar = (spec: string) => /(^|\/)command($|-|\.)|CommandBar/i.test(spec);

describe("nothing the bar does can be reached from the code it must not break", () => {
  it.each([
    "home/api.ts", // runCluster: Home's one-click organize
    "home/organize.ts",
    "home/compose.ts",
    "home/navigation.ts", // (imports only the signal file, which is not the bar)
    "ui/agents.ts", // pressAgent / readAgents: the five agents
    "ui/AgentsColumn.tsx",
    "ui/actions.ts",
    "corrections/api.ts",
    "sidebar/api.ts",
    "sidebar/context.ts",
  ])("%s does not import the bar", (file) => {
    const specs = importsOf(read(file)).filter(mentionsBar);
    // navigation.ts is allowed exactly one thing: the signal file, which carries no UI and no logic of the bar.
    const allowed = file === "home/navigation.ts" ? ["../ui/command-signal"] : [];
    expect(specs).toEqual(allowed);
  });

  it("the bar's own modules are the only ones that import each other", () => {
    for (const file of ["ui/command.ts", "ui/command-signal.ts"]) {
      const specs = importsOf(read(file));
      expect(specs.filter((s) => s.startsWith("../home") || s.startsWith("../sidebar")), file).toEqual([]); // nothing Home- or sidebar-specific
    }
    expect(importsOf(read("ui/CommandBar.tsx")).filter((s) => s.includes("home/") || s.includes("sidebar/"))).toEqual([]);
  });

  it("the bar's hook runs only inside a child component wrapped in the error boundary, on both surfaces", () => {
    for (const [file, component, screen] of [
      ["home/Home.tsx", "HomeCommandBar", "Home"],
      ["sidebar/Sidebar.tsx", "SidebarCommandBar", "Sidebar"],
    ] as const) {
      const source = read(file);
      // The hook is called exactly once, and inside the child (which is defined BEFORE the screen component).
      expect(source.match(/useCommandBar\(/g), file).toHaveLength(1);
      expect(source.indexOf("useCommandBar(")).toBeGreaterThan(source.indexOf(`function ${component}`));
      expect(source.indexOf("useCommandBar(")).toBeLessThan(source.indexOf(`export function ${screen}`));
      // The child is only ever rendered inside the boundary, and so is the visible control.
      expect(source).toMatch(new RegExp(`<CommandBarBoundary>\\s*<${component}`));
      // The visible control: the panel has the button; on Home the URL bar itself is the control (inline variant).
      if (file === "sidebar/Sidebar.tsx") expect(source).toMatch(/<CommandBarBoundary>\s*<CommandBarButton/);
      else expect(source).toContain('variant="inline"');
    }
  });

  it("the shortcut handler is wired in the service worker as wiring only, after the panel gate", () => {
    const background = read("background.ts");
    expect(background).toContain("installCommandShortcut({");
    expect(background.indexOf("installCommandShortcut(")).toBeGreaterThan(background.indexOf("installSidePanelGate()"));
    expect(importsOf(read("command-shortcut.ts")).filter((s) => s.startsWith("./collector") || s.startsWith("./sender") || s.startsWith("./store"))).toEqual([]);
  });
});

describe("the error boundary", () => {
  it("turns any failure inside the bar into nothing, so the page around it keeps working", () => {
    expect(CommandBarBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const boundary = new CommandBarBoundary({ children: "the bar" });
    expect(boundary.render()).toBe("the bar"); // not failed: it renders what it wraps
    boundary.state = { failed: true };
    expect(boundary.render()).toBeNull(); // failed: it renders nothing
    boundary.componentDidCatch();
    expect(warn).toHaveBeenCalledWith("[ai-browser] the command bar failed"); // a fixed label, never the error's text
    warn.mockRestore();
  });
});
