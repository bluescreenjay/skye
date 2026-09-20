import { describe, expect, it, vi } from "vitest";
import type { CommandAction, CommandApplyResult, CommandReply, UndoState } from "@ai-browser/shared";
import { COMMAND_EXAMPLES } from "@ai-browser/shared";
import type { Config } from "../src/config";
import {
  applyCommand,
  barReducer,
  clipCommand,
  COMMAND_MAX_CHARS,
  describeUndo,
  EXAMPLES,
  failureMessage,
  initialBarState,
  interpretCommand,
  isBusy,
  readUndo,
  SHORTENED_NOTE,
  UNPAIRED_MESSAGE,
  UNREACHABLE_MESSAGE,
  type BarEvent,
  type BarState,
} from "../src/ui/command";

const config: Config = { apiBaseUrl: "http://api.test", deviceToken: "device-token-0001" };
const context = { surface: "home" as const, timeZone: "America/New_York", expandedWorkspaceIds: [], activeTab: null, windowTabIds: [] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchOf = (response: Response | (() => Response | Promise<Response>)) => vi.fn(async () => (typeof response === "function" ? response() : response.clone())) as unknown as typeof fetch;

describe("clipCommand", () => {
  it("trims, and cuts only above 300 characters, saying so", () => {
    expect(clipCommand("  organize my tabs  ")).toEqual({ text: "organize my tabs", cut: false });
    expect(clipCommand("a".repeat(299))).toEqual({ text: "a".repeat(299), cut: false });
    expect(clipCommand("a".repeat(300))).toEqual({ text: "a".repeat(300), cut: false });
    expect(clipCommand("a".repeat(301))).toEqual({ text: "a".repeat(COMMAND_MAX_CHARS), cut: true });
    expect(clipCommand("   ")).toEqual({ text: "", cut: false });
  });
});

describe("the examples", () => {
  it("are the six fixed commands", () => {
    expect([...EXAMPLES]).toEqual([...COMMAND_EXAMPLES]);
    expect(EXAMPLES).toHaveLength(6);
  });
});

describe("the client never throws: every request ends as a value", () => {
  const reply: CommandReply = { kind: "say", message: "I can't do that.", help: null };

  it("interpretCommand: ok, refused, unreachable, unpaired", async () => {
    const ok = await interpretCommand(config, { text: "hi", context }, { fetchImpl: fetchOf(json(reply)) });
    expect(ok).toEqual({ kind: "ok", value: reply });

    const refused = await interpretCommand(config, { text: "hi", context }, { fetchImpl: fetchOf(json({ error: "The daily AI limit has been reached. Try again tomorrow.", code: "budget_exhausted" }, 429)) });
    expect(refused).toEqual({ kind: "refused", status: 429, code: "budget_exhausted", message: "The daily AI limit has been reached. Try again tomorrow." });

    const down = await interpretCommand(config, { text: "hi", context }, { fetchImpl: fetchOf(() => { throw new TypeError("Failed to fetch"); }) });
    expect(down).toEqual({ kind: "unreachable" });

    const fetchSpy = vi.fn();
    const unpaired = await interpretCommand(null, { text: "hi", context }, { fetchImpl: fetchSpy as unknown as typeof fetch });
    expect(unpaired).toEqual({ kind: "unpaired" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the command and the context with the device token", async () => {
    const spy = fetchOf(json(reply));
    await interpretCommand(config, { text: "organize my tabs", context }, { fetchImpl: spy });
    const [url, init] = (spy as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe("http://api.test/api/command");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer device-token-0001");
    expect(JSON.parse(init.body as string)).toEqual({ text: "organize my tabs", context });
  });

  it("never turns a body it does not understand into a result", async () => {
    for (const body of [{}, { kind: "explode" }, [], "text", null]) {
      const result = await interpretCommand(config, { text: "hi", context }, { fetchImpl: fetchOf(json(body)) });
      expect(result.kind).toBe("refused");
    }
    const notJson = await interpretCommand(config, { text: "hi", context }, { fetchImpl: fetchOf(new Response("<html>", { status: 200 })) });
    expect(notJson.kind).toBe("refused");
    const serverError = await interpretCommand(config, { text: "hi", context }, { fetchImpl: fetchOf(new Response("boom", { status: 500 })) });
    expect(serverError).toMatchObject({ kind: "refused", status: 500 });
  });

  it("does not show an unlabelled server sentence: a 401 is the pairing message, and an error with no code is generic", async () => {
    const unauthorized = await interpretCommand(config, { text: "hi", context }, { fetchImpl: fetchOf(json({ error: "Invalid pairing token" }, 401)) });
    expect(unauthorized).toMatchObject({ kind: "refused", status: 401, message: "Pairing failed. Check your device token." });
    const stray = await interpretCommand(config, { text: "hi", context }, { fetchImpl: fetchOf(json({ error: "select * from tab_refs" }, 500)) });
    expect(stray).toMatchObject({ kind: "refused", message: "Something went wrong. Try again." });
  });

  it("applyCommand: ok for every status, refused, unreachable, unpaired", async () => {
    const action: CommandAction = { type: "organize" };
    const results: CommandApplyResult[] = [
      { status: "needs_confirmation", preview: { title: "x", lines: [], hiddenCount: 0 } },
      { status: "done", message: "Done.", counts: { moved: 1, alreadyThere: 0, missing: 0, workspacesCreated: 0, suggestions: 0, leftOut: 0 }, undo: null, next: null, workspace: null },
      { status: "nothing_to_do", message: "Nothing to organize.", undo: null },
      { status: "refused", code: "not_found", message: "That workspace or those tabs changed. Ask again." },
    ];
    for (const result of results) expect(await applyCommand(config, action, false, { fetchImpl: fetchOf(json(result)) })).toEqual({ kind: "ok", value: result });
    expect(await applyCommand(config, action, true, { fetchImpl: fetchOf(json({ error: "The command failed" }, 500)) })).toMatchObject({ kind: "refused" });
    expect(await applyCommand(config, action, true, { fetchImpl: fetchOf(() => { throw new Error("x"); }) })).toEqual({ kind: "unreachable" });
    expect(await applyCommand(null, action, true)).toEqual({ kind: "unpaired" });
  });

  it("applyCommand sends the action and whether it was confirmed", async () => {
    const spy = fetchOf(json({ status: "nothing_to_do", message: "m", undo: null }));
    await applyCommand(config, { type: "undo" }, true, { fetchImpl: spy });
    const [url, init] = (spy as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe("http://api.test/api/command/apply");
    expect(JSON.parse(init.body as string)).toEqual({ action: { type: "undo" }, confirmed: true });
  });

  it("readUndo: a state, null (nothing to undo is a real answer), a broken body, unreachable, unpaired", async () => {
    const undo: UndoState = { kind: "move", summary: "moved 3 tabs to Kyoto trip", expiresAt: "2026-09-20T12:00:00.000Z" };
    expect(await readUndo(config, { fetchImpl: fetchOf(json({ undo })) })).toEqual({ kind: "ok", value: undo });
    expect(await readUndo(config, { fetchImpl: fetchOf(json({ undo: null })) })).toEqual({ kind: "ok", value: null });
    expect((await readUndo(config, { fetchImpl: fetchOf(json({ undo: { nope: 1 } })) })).kind).toBe("refused");
    expect((await readUndo(config, { fetchImpl: fetchOf(json({})) })).kind).toBe("refused");
    expect(await readUndo(config, { fetchImpl: fetchOf(() => { throw new Error("x"); }) })).toEqual({ kind: "unreachable" });
    expect(await readUndo(null)).toEqual({ kind: "unpaired" });
  });

  it("describes what it could not do in plain sentences", () => {
    expect(failureMessage({ kind: "unreachable" })).toBe(UNREACHABLE_MESSAGE);
    expect(failureMessage({ kind: "unpaired" })).toBe(UNPAIRED_MESSAGE);
    expect(failureMessage({ kind: "refused", status: 429, code: "x", message: "Try later." })).toBe("Try later.");
    expect(describeUndo({ kind: "move", summary: "moved 3 tabs to X", expiresAt: "" })).toBe("Undo: moved 3 tabs to X");
  });
});

describe("the bar's state machine", () => {
  const run = (events: BarEvent[], from: BarState = initialBarState): BarState => events.reduce(barReducer, from);

  it("starts closed and idle, and opens and closes without changing what it is doing", () => {
    expect(initialBarState).toMatchObject({ open: false, text: "", view: { kind: "idle" }, undo: null });
    expect(run([{ type: "open" }]).open).toBe(true);
    expect(run([{ type: "open" }, { type: "toggle" }]).open).toBe(false);
    expect(run([{ type: "toggle" }, { type: "toggle" }, { type: "toggle" }]).open).toBe(true);
  });

  it("goes idle to interpreting to running when a command is submitted and understood", () => {
    const s1 = run([{ type: "open" }, { type: "type", text: "organize my tabs" }]);
    expect(s1).toMatchObject({ text: "organize my tabs", view: { kind: "idle" } });
    const s2 = barReducer(s1, { type: "submit", text: "organize my tabs" });
    expect(s2.view).toEqual({ kind: "interpreting" });
    expect(isBusy(s2.view)).toBe(true);
    const s3 = barReducer(s2, { type: "reply", reply: { kind: "action", understood: "Organizing your 6 loose tabs.", action: { type: "organize" } } });
    expect(s3.view).toEqual({ kind: "running", understood: "Organizing your 6 loose tabs." });
  });

  it("ignores an empty or whitespace submit (no request would be made)", () => {
    const s = run([{ type: "open" }]);
    for (const text of ["", "   ", "\n"]) expect(barReducer(s, { type: "submit", text })).toBe(s);
  });

  it("clips a long command and says so", () => {
    const s = barReducer(initialBarState, { type: "submit", text: "a".repeat(400) });
    expect(s.text).toHaveLength(300);
    expect(s.note).toBe(SHORTENED_NOTE);
    expect(barReducer(initialBarState, { type: "submit", text: "short" }).note).toBeNull();
  });

  it("does not accept a second command while one is running", () => {
    const busy = run([{ type: "submit", text: "organize my tabs" }]);
    expect(barReducer(busy, { type: "submit", text: "something else" })).toBe(busy);
    expect(barReducer(busy, { type: "type", text: "x" })).toBe(busy);
  });

  it("keeps the typed text when a command fails (FR-026)", () => {
    const s = run([{ type: "submit", text: "organize my tabs" }, { type: "failed", message: "Can't reach the server." }]);
    expect(s.text).toBe("organize my tabs");
    expect(s.view).toEqual({ kind: "failed", message: "Can't reach the server." });
    expect(isBusy(s.view)).toBe(false); // so Try again (a new submit) is accepted
    expect(barReducer(s, { type: "submit", text: s.text }).view).toEqual({ kind: "interpreting" });
  });

  it("closing never cancels or clears what is running or finished (FR-003)", () => {
    const running = run([{ type: "open" }, { type: "submit", text: "organize my tabs" }, { type: "reply", reply: { kind: "action", understood: "U", action: { type: "organize" } } }]);
    const closed = barReducer(running, { type: "close" });
    expect(closed.open).toBe(false);
    expect({ ...closed, open: true }).toEqual(running);
    const finished = barReducer(closed, {
      type: "applied",
      action: { type: "organize" },
      result: { status: "done", message: "Moved 4 tabs into 2 workspaces.", counts: { moved: 4, alreadyThere: 0, missing: 0, workspacesCreated: 2, suggestions: 0, leftOut: 0 }, undo: { kind: "organize", summary: "organized 4 tabs", expiresAt: "e" }, next: null, workspace: null },
    });
    expect(finished.open).toBe(false);
    expect(finished.view).toMatchObject({ kind: "done", message: "Moved 4 tabs into 2 workspaces." });
    expect(barReducer(finished, { type: "open" })).toMatchObject({ open: true, view: { kind: "done" }, undo: { kind: "organize" } });
  });

  it("shows a preview for a change that needs confirming, and confirm or cancel resolve it", () => {
    const action: CommandAction = { type: "move", tabRefIds: ["t"], toWorkspaceId: null };
    const running = run([{ type: "submit", text: "put these back in Other" }, { type: "reply", reply: { kind: "action", understood: "Moving 1 tab to Other.", action } }]);
    const confirming = barReducer(running, { type: "applied", action, result: { status: "needs_confirmation", preview: { title: "Move 1 tab to Other", lines: [], hiddenCount: 0 } } });
    expect(confirming.view).toMatchObject({ kind: "confirming", understood: "Moving 1 tab to Other.", action });
    expect(barReducer(confirming, { type: "confirm" }).view).toEqual({ kind: "running", understood: "Moving 1 tab to Other." });
    expect(barReducer(confirming, { type: "cancel" }).view).toEqual({ kind: "idle" });
    // Confirm outside a preview does nothing.
    expect(barReducer(running, { type: "confirm" })).toBe(running);
  });

  it("shows plain messages, questions, and answers without running anything", () => {
    const base = run([{ type: "submit", text: "x" }]);
    expect(barReducer(base, { type: "reply", reply: { kind: "say", message: "I can't do that.", help: ["organize my tabs"] } }).view).toEqual({ kind: "say", message: "I can't do that.", help: ["organize my tabs"] });
    const ask = barReducer(base, { type: "reply", reply: { kind: "ask", question: "Which?", choices: [{ label: "A", step: { kind: "submit", text: "organize my tabs" } }] } });
    expect(ask.view).toMatchObject({ kind: "ask", question: "Which?" });
    expect(barReducer(base, { type: "reply", reply: { kind: "navigate", understood: "Showing your workspaces.", target: { kind: "home" } } }).view).toEqual({ kind: "done", message: "Showing your workspaces.", workspace: null });
    expect(barReducer(base, { type: "reply", reply: { kind: "recalled", understood: "U", periodLabel: "yesterday", workspaces: [] } }).view).toMatchObject({ kind: "recalled", periodLabel: "yesterday" });
    expect(barReducer(base, { type: "reply", reply: { kind: "found", understood: "U", tabs: [], workspaces: [], more: 0, cutNote: null } }).view).toMatchObject({ kind: "found" });
  });

  it("a submit choice puts its phrase in the box (a new command); an action choice runs", () => {
    const ask = run([{ type: "reply", reply: { kind: "ask", question: "?", choices: [] } }]);
    const filled = barReducer(ask, { type: "choose", choice: { label: "organize my tabs", step: { kind: "submit", text: "organize my tabs" } } });
    expect(filled).toMatchObject({ text: "organize my tabs", view: { kind: "idle" } });
    const acted = barReducer(ask, { type: "choose", choice: { label: "Hackathon", step: { kind: "action", action: { type: "organize" } } } });
    expect(acted.view).toEqual({ kind: "running", understood: "Hackathon" });
  });

  it("keeps Undo across results and updates it from the server", () => {
    const undo: UndoState = { kind: "move", summary: "moved 3 tabs to X", expiresAt: "e" };
    const s = run([{ type: "undo-loaded", undo }, { type: "type", text: "next" }, { type: "cancel" }]);
    expect(s.undo).toEqual(undo);
    expect(barReducer(s, { type: "undo-loaded", undo: null }).undo).toBeNull();
    const nothing = barReducer(s, { type: "applied", action: { type: "undo" }, result: { status: "nothing_to_do", message: "There is nothing to undo.", undo: null } });
    expect(nothing.undo).toBeNull();
    expect(nothing.view).toEqual({ kind: "say", message: "There is nothing to undo.", help: null });
  });

  it("a refused apply is a plain failure, not a result", () => {
    const s = run([{ type: "submit", text: "rename this workspace to X" }, { type: "applied", action: { type: "organize" }, result: { status: "refused", code: "name_taken", message: "That name is already in use." } }]);
    expect(s.view).toEqual({ kind: "failed", message: "That name is already in use." });
    expect(s.text).toBe("rename this workspace to X");
  });

  it("offers a duplicate list only when there are extras, and says so when there are none", () => {
    const plan = { groups: [{ url: "https://a.test/", title: "A", keep: 1, close: [2] }], totalToClose: 1 };
    expect(barReducer(initialBarState, { type: "duplicates", plan }).view).toEqual({ kind: "duplicates", plan, closing: false });
    expect(barReducer(initialBarState, { type: "duplicates", plan: { groups: [], totalToClose: 0 } }).view).toEqual({ kind: "say", message: "No duplicate tabs found.", help: null });
    const closing = run([{ type: "duplicates", plan }, { type: "closing-duplicates" }]);
    expect(isBusy(closing.view)).toBe(true);
    expect(barReducer(closing, { type: "duplicates-done", message: "Closed 1 tab." }).view).toEqual({ kind: "done", message: "Closed 1 tab.", workspace: null });
  });
});

// ---------------------------------------------------------------------------------------------------
// User Story 1: the controller (state and flows) against a fake server and a fake host.
// ---------------------------------------------------------------------------------------------------
import { beforeEach as beforeEachController } from "vitest";
import type { CommandHost, DuplicatePlan } from "../src/ui/command";
import { createCommandController, getCommandController, resetCommandControllerForTests } from "../src/ui/command";
import { SIGNAL_KEY, type CommandSignal } from "../src/ui/command-signal";
import { installChromeMock, type ChromeMock } from "./helpers/chrome-mock";

interface FakeServer {
  fetchImpl: typeof fetch;
  calls: { path: string; method: string; body: unknown }[];
  /** Answers by path; a function is called with the parsed body. */
  on(path: string, answer: (body: unknown) => Response | Promise<Response>): void;
}

function fakeServer(): FakeServer {
  const routes = new Map<string, (body: unknown) => Response | Promise<Response>>();
  const calls: FakeServer["calls"] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path, method: init.method ?? "GET", body });
    const answer = routes.get(path);
    if (!answer) throw new TypeError("Failed to fetch");
    return answer(body);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, on: (path, answer) => void routes.set(path, answer) };
}

function fakeHost(): CommandHost & {
  refreshed: number;
  homes: unknown[];
  opened: unknown[];
  plan: DuplicatePlan;
  closeResult: { closed: number; skipped: number };
  closes: DuplicatePlan[];
  scanFails: boolean;
} {
  const host = {
    surface: "home" as const,
    refreshed: 0,
    homes: [] as unknown[],
    opened: [] as unknown[],
    plan: { groups: [], totalToClose: 0 } as DuplicatePlan,
    closeResult: { closed: 0, skipped: 0 },
    closes: [] as DuplicatePlan[],
    scanFails: false,
    getContext: async () => context,
    refresh() {
      host.refreshed += 1;
    },
    showHome: async (target: unknown) => {
      host.homes.push(target);
    },
    openTab: async (tab: unknown) => {
      host.opened.push(tab);
    },
    scanDuplicates: async () => {
      if (host.scanFails) throw new Error("no tabs");
      return host.plan;
    },
    closeDuplicates: async (plan: DuplicatePlan) => {
      host.closes.push(plan);
      return host.closeResult;
    },
  };
  return host as never;
}

const undoOf = (summary = "organized 4 tabs into 2 workspaces"): UndoState => ({ kind: "organize", summary, expiresAt: "2026-09-20T12:10:00.000Z" });
const doneResult = (undo: UndoState | null = undoOf()): CommandApplyResult => ({
  status: "done",
  message: "Moved 4 tabs into 2 workspaces.",
  counts: { moved: 4, alreadyThere: 0, missing: 0, workspacesCreated: 2, suggestions: 0, leftOut: 0 },
  undo,
  next: null,
  workspace: null,
});
const organizeReply: CommandReply = { kind: "action", understood: "Organizing your 6 loose tabs.", action: { type: "organize" } };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("User Story 1: the bar's flows", () => {
  let mock: ChromeMock;
  let server: FakeServer;
  let host: ReturnType<typeof fakeHost>;

  beforeEachController(() => {
    mock = installChromeMock();
    resetCommandControllerForTests();
    server = fakeServer();
    server.on("/api/command/undo", () => json({ undo: null }));
    host = fakeHost();
  });
  const make = () => createCommandController({ config, host, fetchImpl: server.fetchImpl });
  const aiCalls = () => server.calls.filter((c) => c.path === "/api/command" || c.path === "/api/command/apply");
  const signal = () => mock.session.get(SIGNAL_KEY) as CommandSignal | undefined;

  it("opening and typing make no interpretation request (FR-002): only the undo state is read", async () => {
    const c = make();
    c.toggle();
    await flush();
    c.type("organize");
    c.type("organize my");
    c.type("organize my tabs");
    await flush();
    expect(c.getState()).toMatchObject({ open: true, text: "organize my tabs", view: { kind: "idle" } });
    expect(aiCalls()).toEqual([]);
    expect(server.calls.map((call) => call.path)).toEqual(["/api/command/undo"]);
  });

  it("does nothing for empty or whitespace text", async () => {
    const c = make();
    await c.submit("");
    await c.submit("    ");
    expect(server.calls).toEqual([]);
    expect(c.getState().view).toEqual({ kind: "idle" });
  });

  it("cuts a 301-character command to 300, says so, and sends the cut text", async () => {
    server.on("/api/command", () => json({ kind: "say", message: "I can't do that.", help: null }));
    const c = make();
    await c.submit("a".repeat(301));
    expect(c.getState().note).toBe(SHORTENED_NOTE);
    expect((aiCalls()[0].body as { text: string }).text).toHaveLength(300);
  });

  it("sends the context from the host and the typed text", async () => {
    server.on("/api/command", () => json({ kind: "say", message: "x", help: null }));
    await make().submit("  organize my tabs ");
    expect(aiCalls()[0].body).toEqual({ text: "organize my tabs", context });
  });

  it("organize: understood, then applied, then done with Undo, a refresh, and a changed signal", async () => {
    server.on("/api/command", () => json(organizeReply));
    server.on("/api/command/apply", () => json(doneResult()));
    const c = make();
    await c.submit("organize my tabs");
    expect(aiCalls().map((call) => call.path)).toEqual(["/api/command", "/api/command/apply"]);
    expect(aiCalls()[1].body).toEqual({ action: { type: "organize" }, confirmed: false });
    expect(c.getState().view).toEqual({ kind: "done", message: "Moved 4 tabs into 2 workspaces.", workspace: null });
    expect(c.getState().undo).toEqual(undoOf());
    expect(host.refreshed).toBe(1);
    expect(signal()).toMatchObject({ kind: "changed" });
  });

  it("Undo sends exactly one apply { undo }, then clears the control and refreshes", async () => {
    server.on("/api/command", () => json(organizeReply));
    const undone: CommandApplyResult = { status: "done", message: "Undone. Put 4 tabs back.", counts: { moved: 4, alreadyThere: 0, missing: 0, workspacesCreated: 0, suggestions: 0, leftOut: 0 }, undo: null, next: null, workspace: null };
    server.on("/api/command/apply", (body) => json((body as { action: CommandAction }).action.type === "undo" ? undone : doneResult()));
    const c = make();
    await c.submit("organize my tabs");
    const before = aiCalls().length;
    await c.undo();
    const applies = aiCalls().slice(before);
    expect(applies.map((call) => call.body)).toEqual([{ action: { type: "undo" }, confirmed: false }]);
    expect(c.getState().undo).toBeNull();
    expect(c.getState().view).toMatchObject({ kind: "done", message: "Undone. Put 4 tabs back." });
    expect(host.refreshed).toBe(2);
  });

  it("navigation (show my workspaces) asks the host to bring Home forward and changes nothing else", async () => {
    server.on("/api/command", () => json({ kind: "navigate", understood: "Showing your workspaces.", target: { kind: "home" } }));
    const c = make();
    await c.submit("show my workspaces");
    expect(host.homes).toEqual([{ kind: "home" }]);
    expect(aiCalls().map((call) => call.path)).toEqual(["/api/command"]); // no apply
    expect(host.refreshed).toBe(0);
    expect(signal()).toBeUndefined();
  });

  it("a second press while a command is being understood sends nothing more (one request per submit)", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    server.on("/api/command", async () => {
      await held;
      return json({ kind: "say", message: "ok", help: null });
    });
    const c = make();
    const first = c.submit("organize my tabs");
    await flush();
    await c.submit("organize my tabs");
    await c.submit("organize my tabs");
    release();
    await first;
    expect(server.calls.filter((call) => call.path === "/api/command")).toHaveLength(1);
  });

  it("keeps the typed text when interpreting fails, and Try again is one new request", async () => {
    const c = make(); // no route for /api/command: the fetch throws
    await c.submit("organize my tabs");
    expect(c.getState().text).toBe("organize my tabs");
    expect(c.getState().view).toEqual({ kind: "failed", message: UNREACHABLE_MESSAGE });
    server.on("/api/command", () => json({ kind: "say", message: "I can't do that.", help: null }));
    await c.submit(c.getState().text);
    expect(server.calls.filter((call) => call.path === "/api/command")).toHaveLength(2);
    expect(c.getState().view).toMatchObject({ kind: "say" });
  });

  it("closing while a command runs does not cancel it; the result is there when the bar reopens (FR-003)", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    server.on("/api/command", () => json(organizeReply));
    server.on("/api/command/apply", async () => {
      await held;
      return json(doneResult());
    });
    const c = make();
    c.open();
    const running = c.submit("organize my tabs");
    await flush();
    await flush();
    expect(c.getState().view).toEqual({ kind: "running", understood: "Organizing your 6 loose tabs." });
    c.close();
    expect(c.getState()).toMatchObject({ open: false, view: { kind: "running" } });
    release();
    await running;
    expect(c.getState().open).toBe(false);
    expect(c.getState().view).toMatchObject({ kind: "done" });
    expect(host.refreshed).toBe(1); // it still finished, and Home was told
    c.open();
    expect(c.getState()).toMatchObject({ open: true, view: { kind: "done", message: "Moved 4 tabs into 2 workspaces." }, undo: { kind: "organize" } });
  });

  it("reading the undo state on open offers Undo again after a close (FR-019)", async () => {
    server.on("/api/command/undo", () => json({ undo: undoOf("moved 3 tabs to Kyoto trip") }));
    const c = make();
    c.toggle();
    await flush();
    expect(c.getState().undo).toEqual(undoOf("moved 3 tabs to Kyoto trip"));
  });

  it("a page has ONE controller: asking again returns it, with the newest config", () => {
    const first = getCommandController({ config, host });
    const other: Config = { apiBaseUrl: "http://other.test", deviceToken: "device-token-0002" };
    expect(getCommandController({ config: other, host })).toBe(first);
  });
});

// ---------------------------------------------------------------------------------------------------
// User Story 2: confirming a change the person placed tabs for.
// ---------------------------------------------------------------------------------------------------
describe("User Story 2: previews and confirmation", () => {
  let server: FakeServer;
  let host: ReturnType<typeof fakeHost>;
  beforeEachController(() => {
    installChromeMock();
    resetCommandControllerForTests();
    server = fakeServer();
    server.on("/api/command/undo", () => json({ undo: null }));
    host = fakeHost();
  });
  const make = () => createCommandController({ config, host, fetchImpl: server.fetchImpl });
  const applies = () => server.calls.filter((c) => c.path === "/api/command/apply");

  const createAction: CommandAction = { type: "create", name: "Kyoto trip", tabRefIds: ["t-1", "t-2", "t-3"] };
  const createReply: CommandReply = { kind: "action", understood: "Creating Kyoto trip with 3 tabs.", action: createAction };
  const preview = { title: "Create “Kyoto trip” with 3 tabs", lines: [{ tabRefId: "t-1", title: "Flights to Osaka", from: "Other", to: "Kyoto trip" }], hiddenCount: 2 };
  const created: CommandApplyResult = {
    status: "done",
    message: "Created Kyoto trip with 3 tabs.",
    counts: { moved: 3, alreadyThere: 0, missing: 0, workspacesCreated: 1, suggestions: 0, leftOut: 0 },
    undo: { kind: "create", summary: "created Kyoto trip with 3 tabs", expiresAt: "e" },
    next: null,
    workspace: { id: "w-1", name: "Kyoto trip" },
  };

  /** The server asks to confirm on the first apply and does it on the second. */
  const confirmingServer = () => {
    server.on("/api/command", () => json(createReply));
    server.on("/api/command/apply", (body) => json((body as { confirmed: boolean }).confirmed ? created : { status: "needs_confirmation", preview }));
  };

  it("shows the preview and changes nothing until Confirm", async () => {
    confirmingServer();
    const c = createCommandController({ config, host, fetchImpl: server.fetchImpl });
    await c.submit("create a workspace for these tabs");
    expect(c.getState().view).toMatchObject({ kind: "confirming", understood: "Creating Kyoto trip with 3 tabs.", action: createAction, preview });
    expect(applies()).toHaveLength(1);
    expect((applies()[0].body as { confirmed: boolean }).confirmed).toBe(false);
    expect(host.refreshed).toBe(0); // nothing changed yet
  });

  it("Cancel makes no request and changes nothing", async () => {
    confirmingServer();
    const c = make();
    await c.submit("create a workspace for these tabs");
    const before = server.calls.length;
    c.cancel();
    expect(server.calls.length).toBe(before);
    expect(c.getState().view).toEqual({ kind: "idle" });
    expect(host.refreshed).toBe(0);
  });

  it("Confirm sends the same action with confirmed: true exactly once, then shows the result and Undo", async () => {
    confirmingServer();
    const c = make();
    await c.submit("create a workspace for these tabs");
    await c.confirm();
    expect(applies().map((call) => call.body)).toEqual([
      { action: createAction, confirmed: false },
      { action: createAction, confirmed: true },
    ]);
    expect(c.getState().view).toEqual({ kind: "done", message: "Created Kyoto trip with 3 tabs.", workspace: { id: "w-1", name: "Kyoto trip" } });
    expect(c.getState().undo).toMatchObject({ kind: "create" });
    expect(host.refreshed).toBe(1);
  });

  it("a second Confirm click while the first is running is ignored", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    server.on("/api/command", () => json(createReply));
    server.on("/api/command/apply", async (body) => {
      if ((body as { confirmed: boolean }).confirmed) {
        await held;
        return json(created);
      }
      return json({ status: "needs_confirmation", preview });
    });
    const c = make();
    await c.submit("create a workspace for these tabs");
    const first = c.confirm();
    await flush();
    await c.confirm();
    await c.confirm();
    release();
    await first;
    expect(applies().filter((call) => (call.body as { confirmed: boolean }).confirmed)).toHaveLength(1);
  });

  it("a refusal on Confirm is a plain failure and keeps the typed text", async () => {
    server.on("/api/command", () => json(createReply));
    server.on("/api/command/apply", (body) => json((body as { confirmed: boolean }).confirmed ? { status: "refused", code: "name_taken", message: "That name is already in use." } : { status: "needs_confirmation", preview }));
    const c = make();
    await c.submit("create a workspace for these tabs");
    await c.confirm();
    expect(c.getState().view).toEqual({ kind: "failed", message: "That name is already in use." });
    expect(c.getState().text).toBe("create a workspace for these tabs");
  });

  it("does not need the preview when the server does the change at once", async () => {
    server.on("/api/command", () => json(createReply));
    server.on("/api/command/apply", () => json(created));
    const c = make();
    await c.submit("create a workspace for these tabs");
    expect(applies()).toHaveLength(1);
    expect(c.getState().view.kind).toBe("done");
  });
});

// ---------------------------------------------------------------------------------------------------
// User Story 3: an agent started from the bar is the Home card's own run.
// ---------------------------------------------------------------------------------------------------
import { AGENT_WAIT_MS, runAgentFromBar, agentName, ALREADY_RUNNING_MESSAGE, closedMessage, LOST_TOUCH_MESSAGE, STILL_RUNNING_MESSAGE } from "../src/ui/command";
import { POLL_MS } from "../src/ui/agents";

describe("User Story 3: running an agent from the bar", () => {
  const W = "workspace-1";
  const agentAction = { type: "agent" as const, workspaceId: W, agentId: "summarize" as const };
  const run = (state: "running" | "succeeded" | "failed", extra: Record<string, unknown> = {}) => ({
    id: "run-1",
    agentId: "summarize",
    state,
    createdAt: "2026-09-20T12:00:00.000Z",
    input: { tabsTotal: 2, tabsIncluded: 2, pagesTried: 0, chatMessages: 0, planItems: 0 },
    output: null,
    error: null,
    ...extra,
  });
  const done = run("succeeded", { output: { result: { kind: "text", text: "Two pages about a hackathon.", cited: [{ title: "Hackathon rules", url: "https://hack.example/rules" }] }, sources: [], coverage: { tabsTotal: 2, tabsIncluded: 2, pagesRead: 0 } } });
  const entries = (over: Record<string, unknown>) => ({
    agents: [{ id: "summarize", name: "summarize", description: "d", kind: "text", latest: null, running: null, lastFailed: null, ...over }],
    planItems: [],
  });

  let server: FakeServer;
  let clock: number;
  const opts = () => ({ fetchImpl: server.fetchImpl, now: () => clock, sleep: async (ms: number) => void (clock += ms) });
  const pressPath = `/api/workspaces/${W}/agents/summarize/run`;
  const readPath = `/api/workspaces/${W}/agents`;
  beforeEachController(() => {
    installChromeMock();
    clock = 0;
    server = fakeServer();
  });

  it("presses the card's own route, polls the card's own read at the card's own interval, and shows a short result", async () => {
    server.on(pressPath, () => json({ run: run("running") }, 202));
    let reads = 0;
    server.on(readPath, () => json(++reads < 3 ? entries({ running: run("running") }) : entries({ latest: done })));
    const result = await runAgentFromBar(config, agentAction, "Running summarize for Hackathon.", opts());
    expect(result.started).toBe(true);
    expect(result.view).toMatchObject({ kind: "agent", phase: "result", message: null, workspaceId: W });
    expect(result.view.lines).toEqual(["Two pages about a hackathon.", "from: Hackathon rules"]);
    expect(server.calls.filter((c) => c.path === pressPath)).toHaveLength(1); // never presses twice
    expect(server.calls.find((c) => c.path === pressPath)?.method).toBe("POST");
    expect(reads).toBe(3);
    expect(clock).toBe(3 * POLL_MS);
  });

  it("cuts a long result to six lines (the full one is on the card)", async () => {
    server.on(pressPath, () => json({ run: run("running") }, 202));
    const items = Array.from({ length: 9 }, (_, i) => `step ${i + 1}`);
    server.on(readPath, () => json(entries({ latest: run("succeeded", { output: { result: { kind: "checklist", items }, sources: [], coverage: { tabsTotal: 1, tabsIncluded: 1, pagesRead: 0 } } }) })));
    const { view } = await runAgentFromBar(config, agentAction, "u", opts());
    expect(view.lines).toEqual(items.slice(0, 6));
  });

  it("already running is a plain message, not an error, and starts nothing new", async () => {
    server.on(pressPath, () => json({ error: "This agent is already running for this workspace.", code: "run_in_progress" }, 409));
    const result = await runAgentFromBar(config, agentAction, "u", opts());
    expect(result).toEqual({ started: false, view: { kind: "agent", understood: "u", workspaceId: W, phase: "failed", lines: [], message: ALREADY_RUNNING_MESSAGE } });
    expect(server.calls.filter((c) => c.path === readPath)).toHaveLength(0);
  });

  it("a workspace with no web tabs shows the card's own sentence, with no polling", async () => {
    server.on(pressPath, () => json({ error: "Add some web tabs to this workspace first, then run an agent.", code: "no_tabs" }, 409));
    const { view, started } = await runAgentFromBar(config, agentAction, "u", opts());
    expect(started).toBe(false);
    expect(view).toMatchObject({ phase: "failed", message: "Add some web tabs to this workspace first, then run an agent." });
    expect(server.calls).toHaveLength(1);
  });

  it("stops waiting after 90 seconds and says the result will be on the card", async () => {
    server.on(pressPath, () => json({ run: run("running") }, 202));
    server.on(readPath, () => json(entries({ running: run("running") })));
    const { view, started } = await runAgentFromBar(config, agentAction, "u", opts());
    expect(started).toBe(true);
    expect(view).toMatchObject({ phase: "still", message: STILL_RUNNING_MESSAGE });
    expect(clock).toBeGreaterThanOrEqual(AGENT_WAIT_MS);
    expect(clock).toBeLessThan(AGENT_WAIT_MS + 2 * POLL_MS);
  });

  it("losing the connection while polling says so, and does not lose the run (it is stored)", async () => {
    server.on(pressPath, () => json({ run: run("running") }, 202));
    // /agents is never answered: the fetch throws
    const { view, started } = await runAgentFromBar(config, agentAction, "u", opts());
    expect(started).toBe(true);
    expect(view).toMatchObject({ phase: "still", message: LOST_TOUCH_MESSAGE });
  });

  it("a failed run shows the run's own fixed sentence and is not shown as a result", async () => {
    server.on(pressPath, () => json({ run: run("running") }, 202));
    server.on(readPath, () => json(entries({ lastFailed: run("failed", { error: { code: "model_error", message: "The AI assistant couldn't run this right now. You can run it again." } }) })));
    const { view } = await runAgentFromBar(config, agentAction, "u", opts());
    expect(view).toMatchObject({ phase: "failed", lines: [], message: "The AI assistant couldn't run this right now. You can run it again." });
  });

  it("an unreachable press and an unpaired browser are plain and press nothing", async () => {
    const down = await runAgentFromBar(config, agentAction, "u", opts());
    expect(down.view).toMatchObject({ phase: "failed", message: UNREACHABLE_MESSAGE });
    expect(down.started).toBe(false);
    const spy = fakeServer();
    const unpaired = await runAgentFromBar(null, agentAction, "u", { ...opts(), fetchImpl: spy.fetchImpl });
    expect(unpaired.view.message).toBe(UNPAIRED_MESSAGE);
    expect(spy.calls).toEqual([]);
  });

  it("names the five agents as the card does", () => {
    expect(["summarize", "compare", "missing", "next-steps", "refs"].map(agentName)).toEqual(["summarize", "compare", "what's missing", "next steps", "collect refs"]);
  });

  it("through the controller: an agent action is pressed (not sent to /apply), shows the result, and tells other pages", async () => {
    const mock = installChromeMock();
    resetCommandControllerForTests();
    const srv = fakeServer();
    srv.on("/api/command", () => json({ kind: "action", understood: "Running summarize for Hackathon.", action: agentAction }));
    srv.on(pressPath, () => json({ run: run("running") }, 202));
    srv.on(readPath, () => json(entries({ latest: done })));
    srv.on("/api/command/undo", () => json({ undo: null }));
    const c = createCommandController({ config, host: fakeHost(), fetchImpl: srv.fetchImpl });
    // The real 3 s poll would slow the test; the controller uses the real timer, so wait it out with a short override.
    const finished = c.submit("summarize hackathon");
    await vi.waitFor(() => expect(c.getState().view).toMatchObject({ kind: "agent", phase: "result" }), { timeout: 6_000, interval: 100 });
    await finished;
    expect(srv.calls.some((call) => call.path === "/api/command/apply")).toBe(false);
    expect(c.getState().view).toMatchObject({ lines: ["Two pages about a hackathon.", "from: Hackathon rules"] });
    expect(mock.session.get(SIGNAL_KEY)).toMatchObject({ kind: "changed" });
  }, 10_000);
});

// ---------------------------------------------------------------------------------------------------
// User Story 4: clean up, and the list of duplicate tabs.
// ---------------------------------------------------------------------------------------------------
describe("User Story 4: the duplicate list", () => {
  let mock: ChromeMock;
  let server: FakeServer;
  let host: ReturnType<typeof fakeHost>;
  const plan: DuplicatePlan = { groups: [{ url: "https://a.test/", title: "Page A", keep: 1, close: [2, 3] }, { url: "https://b.test/", title: "Page B", keep: 4, close: [5] }], totalToClose: 3 };
  const cleanupReply: CommandReply = { kind: "action", understood: "Cleaning up: organizing your 4 loose tabs, then looking for duplicate tabs.", action: { type: "cleanup" } };
  const cleanupDone: CommandApplyResult = { status: "done", message: "Moved 4 tabs into 2 workspaces.", counts: { moved: 4, alreadyThere: 0, missing: 0, workspacesCreated: 2, suggestions: 0, leftOut: 0 }, undo: { kind: "organize", summary: "organized 4 tabs into 2 workspaces", expiresAt: "e" }, next: "scan_duplicates", workspace: null };

  beforeEachController(() => {
    mock = installChromeMock();
    resetCommandControllerForTests();
    server = fakeServer();
    server.on("/api/command", () => json(cleanupReply));
    server.on("/api/command/apply", () => json(cleanupDone));
    server.on("/api/command/undo", () => json({ undo: null }));
    host = fakeHost();
  });
  const make = () => createCommandController({ config, host, fetchImpl: server.fetchImpl });

  it("organizes, then lists the duplicates and closes NOTHING until Confirm", async () => {
    host.plan = plan;
    const c = make();
    await c.submit("clean up my browser");
    expect(c.getState().view).toEqual({ kind: "duplicates", plan, closing: false });
    expect(host.closes).toEqual([]);
    expect(c.getState().undo).toMatchObject({ kind: "organize" }); // the organize step can be undone
  });

  it("Confirm closes once with the same plan, reports the count, and refreshes; a second click is ignored", async () => {
    host.plan = plan;
    host.closeResult = { closed: 3, skipped: 0 };
    const c = make();
    await c.submit("clean up my browser");
    const refreshedBefore = host.refreshed;
    await Promise.all([c.closeDuplicates(), c.closeDuplicates()]);
    expect(host.closes).toEqual([plan]);
    expect(c.getState().view).toEqual({ kind: "done", message: "Closed 3 tabs.", workspace: null });
    expect(host.refreshed).toBe(refreshedBefore + 1);
    expect(mock.session.get(SIGNAL_KEY)).toMatchObject({ kind: "changed" });
  });

  it("says how many were skipped because they changed", async () => {
    host.plan = plan;
    host.closeResult = { closed: 1, skipped: 2 };
    const c = make();
    await c.submit("clean up my browser");
    await c.closeDuplicates();
    expect(c.getState().view).toMatchObject({ kind: "done", message: "Closed 1 tab. 2 skipped because they changed." });
    expect(closedMessage(0, 1)).toBe("No tabs were closed. 1 skipped because it changed.");
    expect(closedMessage(0, 0)).toBe("No tabs were closed.");
  });

  it("Cancel closes nothing", async () => {
    host.plan = plan;
    const c = make();
    await c.submit("clean up my browser");
    c.cancel();
    expect(host.closes).toEqual([]);
    expect(c.getState().view).toEqual({ kind: "idle" });
    await c.closeDuplicates(); // no list on screen: nothing happens
    expect(host.closes).toEqual([]);
  });

  it("says so when there are no duplicates, and makes no close call", async () => {
    const c = make();
    await c.submit("clean up my browser");
    expect(c.getState().view).toEqual({ kind: "say", message: "No duplicate tabs found.", help: null });
    expect(host.closes).toEqual([]);
  });

  it("a scan that fails is a plain failure, not a list", async () => {
    host.scanFails = true;
    const c = make();
    await c.submit("clean up my browser");
    expect(c.getState().view).toEqual({ kind: "failed", message: "Something went wrong. Try again." });
    expect(host.closes).toEqual([]);
  });

  it("a failed organize offers no duplicate list", async () => {
    server.on("/api/command/apply", () => json({ status: "refused", code: "model_error", message: "The AI assistant couldn't organize right now. Try again." }));
    host.plan = plan;
    const c = make();
    await c.submit("clean up my browser");
    expect(c.getState().view).toEqual({ kind: "failed", message: "The AI assistant couldn't organize right now. Try again." });
  });

  it("the duplicate step is offered even when nothing was organized", async () => {
    server.on("/api/command/apply", () => json({ ...cleanupDone, message: "Nothing to organize. Now looking for duplicate tabs.", counts: { ...(cleanupDone as { counts: object }).counts, moved: 0 } }));
    host.plan = plan;
    const c = make();
    await c.submit("clean up my browser");
    expect(c.getState().view.kind).toBe("duplicates");
  });

  it("is busy while closing, so no new command is accepted", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    host.plan = plan;
    host.closeDuplicates = async (p) => {
      host.closes.push(p);
      await held;
      return { closed: 3, skipped: 0 };
    };
    const c = make();
    await c.submit("clean up my browser");
    const closing = c.closeDuplicates();
    await flush();
    expect(isBusy(c.getState().view)).toBe(true);
    const calls = server.calls.length;
    await c.submit("organize my tabs");
    expect(server.calls.length).toBe(calls);
    release();
    await closing;
  });
});

// ---------------------------------------------------------------------------------------------------
// User Story 7: rename and merge previews go through the same confirmation.
// ---------------------------------------------------------------------------------------------------
describe("User Story 7: rename and merge previews", () => {
  let server: FakeServer;
  let host: ReturnType<typeof fakeHost>;
  beforeEachController(() => {
    installChromeMock();
    resetCommandControllerForTests();
    server = fakeServer();
    server.on("/api/command/undo", () => json({ undo: null }));
    host = fakeHost();
  });
  const applies = () => server.calls.filter((c) => c.path === "/api/command/apply");
  const doneFor = (kind: "rename" | "merge", message: string): CommandApplyResult => ({
    status: "done",
    message,
    counts: { moved: kind === "merge" ? 3 : 0, alreadyThere: 0, missing: 0, workspacesCreated: 0, suggestions: 0, leftOut: 0 },
    undo: { kind, summary: `${kind}d`, expiresAt: "e" },
    next: null,
    workspace: { id: "w-2", name: "Errands" },
  });

  const cases: { name: string; action: CommandAction; preview: { title: string; lines: { tabRefId: string | null; title: string; from: string; to: string }[]; hiddenCount: number }; message: string; kind: "rename" | "merge" }[] = [
    {
      name: "a rename",
      kind: "rename",
      action: { type: "rename", workspaceId: "w-1", name: "Errands" },
      preview: { title: "Rename Shopping to Errands", lines: [{ tabRefId: null, title: "Workspace name", from: "Shopping", to: "Errands" }], hiddenCount: 0 },
      message: "Renamed Shopping to Errands.",
    },
    {
      name: "a merge",
      kind: "merge",
      action: { type: "merge", fromWorkspaceId: "w-1", intoWorkspaceId: "w-2" },
      preview: { title: "Merge Shopping into Errands (3 tabs will move)", lines: [{ tabRefId: "t-1", title: "Shop A", from: "Shopping", to: "Errands" }], hiddenCount: 2 },
      message: "Moved 3 tabs from Shopping into Errands.",
    },
  ];

  it.each(cases)("$name shows its preview, changes nothing until Confirm, then sends the SAME action confirmed, once", async ({ action, preview, message, kind }) => {
    server.on("/api/command", () => json({ kind: "action", understood: "U", action }));
    server.on("/api/command/apply", (body) => json((body as { confirmed: boolean }).confirmed ? doneFor(kind, message) : { status: "needs_confirmation", preview }));
    const c = createCommandController({ config, host, fetchImpl: server.fetchImpl });
    await c.submit("do the thing");
    expect(c.getState().view).toMatchObject({ kind: "confirming", action, preview });
    expect(host.refreshed).toBe(0);
    await Promise.all([c.confirm(), c.confirm()]);
    expect(applies().map((call) => call.body)).toEqual([
      { action, confirmed: false },
      { action, confirmed: true },
    ]);
    expect(c.getState().view).toMatchObject({ kind: "done", message });
    expect(c.getState().undo).toMatchObject({ kind });
    expect(host.refreshed).toBe(1);
  });

  it("an ambiguous name is a question: choosing one sends a resolved action to be previewed, with no new AI request", async () => {
    const a: CommandAction = { type: "rename", workspaceId: "w-a", name: "Japan" };
    const b: CommandAction = { type: "rename", workspaceId: "w-b", name: "Japan" };
    server.on("/api/command", () => json({ kind: "ask", question: "Which workspace do you mean?", choices: [{ label: "Trip 2025", step: { kind: "action", action: a } }, { label: "Trip 2026", step: { kind: "action", action: b } }] }));
    server.on("/api/command/apply", () => json({ status: "needs_confirmation", preview: { title: "Rename Trip 2026 to Japan", lines: [], hiddenCount: 0 } }));
    const c = createCommandController({ config, host, fetchImpl: server.fetchImpl });
    await c.submit("rename trip to Japan");
    expect(c.getState().view.kind).toBe("ask");
    const choices = (c.getState().view as { choices: Parameters<typeof c.choose>[0][] }).choices;
    await c.choose(choices[1]);
    expect(server.calls.filter((call) => call.path === "/api/command")).toHaveLength(1); // the choice cost no interpretation request
    expect(applies().map((call) => call.body)).toEqual([{ action: b, confirmed: false }]);
    expect(c.getState().view).toMatchObject({ kind: "confirming", action: b });
  });
});

// ---------------------------------------------------------------------------------------------------
// User Story 6: never surprising, always recoverable.
// ---------------------------------------------------------------------------------------------------
describe("User Story 6: failures and recovery in the bar", () => {
  let server: FakeServer;
  let host: ReturnType<typeof fakeHost>;
  beforeEachController(() => {
    installChromeMock();
    resetCommandControllerForTests();
    server = fakeServer();
    server.on("/api/command/undo", () => json({ undo: null }));
    host = fakeHost();
  });
  const make = (cfg: Config | null = config) => createCommandController({ config: cfg, host, fetchImpl: server.fetchImpl });
  const interprets = () => server.calls.filter((c) => c.path === "/api/command");
  const applies = () => server.calls.filter((c) => c.path === "/api/command/apply");

  it("an unreachable server is ONE plain message, keeps the typed text and what was on screen, and invents no result", async () => {
    const c = make(); // no route for /api/command: the fetch throws
    c.type("organize my tabs");
    await c.submit("organize my tabs");
    expect(c.getState()).toMatchObject({ text: "organize my tabs", view: { kind: "failed", message: "Can't reach the server." }, undo: null });
    await c.submit(c.getState().text); // Try again: another submit, never automatic
    expect(interprets()).toHaveLength(2);
    expect(c.getState().view).toEqual({ kind: "failed", message: "Can't reach the server." }); // still one message, not stacked
  });

  it("an unpaired browser says so and sends nothing at all", async () => {
    const c = make(null);
    await c.submit("organize my tabs");
    expect(c.getState().view).toEqual({ kind: "failed", message: "This browser isn't connected yet." });
    expect(c.getState().text).toBe("organize my tabs");
    expect(server.calls).toEqual([]);
    c.toggle(); // opening asks for the undo state: also nothing when unpaired
    await flush();
    expect(server.calls).toEqual([]);
  });

  it("a failed change is a failure, never a result, and does not touch the Undo control", async () => {
    server.on("/api/command", () => json(organizeReply));
    server.on("/api/command/apply", () => json({ status: "refused", code: "model_error", message: "The AI assistant couldn't organize right now. Try again." }));
    const c = make();
    await c.loadUndo();
    await c.submit("organize my tabs");
    expect(c.getState().view).toEqual({ kind: "failed", message: "The AI assistant couldn't organize right now. Try again." });
    expect(host.refreshed).toBe(0); // nothing changed, so nothing reloaded
    expect(c.getState().text).toBe("organize my tabs");
  });

  it("a typed 'undo' and the Undo control end in the same single apply { undo }", async () => {
    const undone: CommandApplyResult = { status: "done", message: "Undone. Put 4 tabs back.", counts: { moved: 4, alreadyThere: 0, missing: 0, workspacesCreated: 0, suggestions: 0, leftOut: 0 }, undo: null, next: null, workspace: null };
    server.on("/api/command", () => json({ kind: "action", understood: "Undoing your last change.", action: { type: "undo" } }));
    server.on("/api/command/apply", () => json(undone));
    const typed = make();
    await typed.submit("undo");
    expect(interprets()).toHaveLength(1); // a typed command is interpreted like any other: one request
    expect(applies().map((call) => call.body)).toEqual([{ action: { type: "undo" }, confirmed: false }]);

    resetCommandControllerForTests();
    server.calls.length = 0;
    const control = make();
    await control.undo();
    expect(interprets()).toHaveLength(0); // the control needs no interpretation
    expect(applies().map((call) => call.body)).toEqual([{ action: { type: "undo" }, confirmed: false }]);
    expect(control.getState().view).toMatchObject({ kind: "done", message: "Undone. Put 4 tabs back." });
  });

  it("'there is nothing to undo' comes from the server and is shown as a plain message", async () => {
    server.on("/api/command/apply", () => json({ status: "nothing_to_do", message: "There is nothing to undo.", undo: null }));
    const c = make();
    await c.undo();
    expect(c.getState().view).toEqual({ kind: "say", message: "There is nothing to undo.", help: null });
  });

  it("a 'submit' choice becomes a NEW command: its phrase is interpreted (one more request) and nothing ran before it", async () => {
    server.on("/api/command", (body) =>
      (body as { text: string }).text === "organize my tabs && summarize kyoto"
        ? json({ kind: "ask", question: "I do one thing at a time. Which first?", choices: [{ label: "organize my tabs", step: { kind: "submit", text: "organize my tabs" } }, { label: "summarize kyoto", step: { kind: "submit", text: "summarize kyoto" } }] })
        : json({ kind: "say", message: "ok", help: null }),
    );
    const c = make();
    await c.submit("organize my tabs && summarize kyoto");
    expect(applies()).toEqual([]); // the compound command ran nothing
    const choices = (c.getState().view as { choices: Parameters<typeof c.choose>[0][] }).choices;
    await c.choose(choices[0]);
    expect(interprets().map((call) => (call.body as { text: string }).text)).toEqual(["organize my tabs && summarize kyoto", "organize my tabs"]);
    expect(c.getState().text).toBe("organize my tabs");
  });

  it("Escape while a command runs closes the bar; the change still finishes and Home is told (User Story 6 scenario 7)", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    server.on("/api/command", () => json(organizeReply));
    server.on("/api/command/apply", async () => {
      await held;
      return json(doneResult());
    });
    const c = make();
    c.open();
    const running = c.submit("organize my tabs");
    await flush();
    await flush();
    c.close(); // Escape
    release();
    await running;
    expect(host.refreshed).toBe(1);
    expect(c.getState()).toMatchObject({ open: false, view: { kind: "done" } });
  });

  it("the client never throws, whatever the network does", async () => {
    const weird: [string, typeof fetch][] = [
      ["throws a string", (async () => { throw "boom"; }) as never],
      ["throws undefined", (async () => { throw undefined; }) as never],
      ["returns a body that is not JSON", (async () => new Response("<html>", { status: 200 })) as never],
      ["returns a JSON array", (async () => json([1, 2, 3])) as never],
      ["returns a 500 with a stray sentence", (async () => json({ error: "select * from tab_refs" }, 500)) as never],
      ["returns a redirect", (async () => new Response(null, { status: 302 })) as never],
    ];
    for (const [name, fetchImpl] of weird) {
      const requests = await Promise.all([
        interpretCommand(config, { text: "hi", context }, { fetchImpl }),
        applyCommand(config, { type: "undo" }, false, { fetchImpl }),
        readUndo(config, { fetchImpl }),
      ]);
      for (const r of requests) expect(["ok", "refused", "unreachable"], name).toContain(r.kind);
      // A body that is not what was promised is never turned into a result.
      if (name !== "throws a string" && name !== "throws undefined") for (const r of requests.slice(0, 2)) expect(r.kind, name).not.toBe("ok");
    }
    const c = createCommandController({ config, host, fetchImpl: (async () => { throw "boom"; }) as never });
    await expect(c.submit("organize my tabs")).resolves.toBeUndefined();
    await expect(c.loadUndo()).resolves.toBeUndefined();
    await expect(c.undo()).resolves.toBeUndefined();
    expect(c.getState().view.kind).toBe("failed");
  });

  it("a host that throws while reading the context is a plain failure, and nothing is sent", async () => {
    host.getContext = async () => {
      throw new Error("no window");
    };
    const c = make();
    await c.submit("organize my tabs");
    expect(c.getState().view).toEqual({ kind: "failed", message: "Something went wrong. Try again." });
    expect(interprets()).toEqual([]);
  });

  it("a host that throws while coming forward or refreshing does not break the command", async () => {
    server.on("/api/command", () => json({ kind: "navigate", understood: "Showing your workspaces.", target: { kind: "home" } }));
    host.showHome = async () => {
      throw new Error("no window");
    };
    const c = make();
    await c.submit("show my workspaces");
    expect(c.getState().view).toEqual({ kind: "done", message: "Showing your workspaces.", workspace: null });
    server.on("/api/command", () => json(organizeReply));
    server.on("/api/command/apply", () => json(doneResult()));
    host.refresh = () => {
      throw new Error("cannot refresh");
    };
    await c.submit("organize my tabs");
    expect(c.getState().view.kind).toBe("done");
  });
});

// ---------------------------------------------------------------------------------------------------
// User Story 5: "what was I working on yesterday?" is read-only.
// ---------------------------------------------------------------------------------------------------
describe("User Story 5: recall", () => {
  let mock: ChromeMock;
  let server: FakeServer;
  let host: ReturnType<typeof fakeHost>;
  beforeEachController(() => {
    mock = installChromeMock();
    resetCommandControllerForTests();
    server = fakeServer();
    server.on("/api/command/undo", () => json({ undo: null }));
    host = fakeHost();
  });
  const recalled: CommandReply = {
    kind: "recalled",
    understood: "Looking at what you were working on yesterday (Saturday, September 19).",
    periodLabel: "yesterday (Saturday, September 19)",
    workspaces: [
      { workspaceId: "w-1", name: "Kyoto trip", linkable: true, visits: 8, tabs: [{ title: "Flights to Osaka", url: "https://travel.example/flights", visits: 5 }] },
      { workspaceId: null, name: "Other", linkable: false, visits: 1, tabs: [{ title: "A loose page", url: "https://loose.example/x", visits: 1 }] },
    ],
  };

  it("shows the answer and changes nothing: no apply, no refresh, no signal", async () => {
    server.on("/api/command", () => json(recalled));
    const c = createCommandController({ config, host, fetchImpl: server.fetchImpl });
    await c.submit("what was I working on yesterday?");
    expect(c.getState().view).toMatchObject({ kind: "recalled", periodLabel: "yesterday (Saturday, September 19)" });
    expect((c.getState().view as { workspaces: unknown[] }).workspaces).toHaveLength(2);
    expect(server.calls.filter((call) => call.path === "/api/command/apply")).toEqual([]);
    expect(host.refreshed).toBe(0);
    expect(mock.session.get(SIGNAL_KEY)).toBeUndefined();
    expect(isBusy(c.getState().view)).toBe(false);
  });

  it("'nothing was recorded' arrives as a plain message, not an empty list", async () => {
    server.on("/api/command", () => json({ kind: "say", message: "Nothing was recorded for yesterday (Saturday, September 19).", help: null }));
    const c = createCommandController({ config, host, fetchImpl: server.fetchImpl });
    await c.submit("what was I working on yesterday?");
    expect(c.getState().view).toEqual({ kind: "say", message: "Nothing was recorded for yesterday (Saturday, September 19).", help: null });
  });

  it("opening a workspace from the answer is the host's job (Home comes forward with that card)", async () => {
    server.on("/api/command", () => json(recalled));
    const c = createCommandController({ config, host, fetchImpl: server.fetchImpl });
    await c.submit("what was I working on yesterday?");
    await host.showHome({ kind: "workspace", workspaceId: "w-1" });
    expect(host.homes).toEqual([{ kind: "workspace", workspaceId: "w-1" }]);
  });
});

// ---------------------------------------------------------------------------------------------------
// User Story 8: find a tab or workspace by describing it (read-only).
// ---------------------------------------------------------------------------------------------------
describe("User Story 8: find", () => {
  let mock: ChromeMock;
  let server: FakeServer;
  let host: ReturnType<typeof fakeHost>;
  beforeEachController(() => {
    mock = installChromeMock();
    resetCommandControllerForTests();
    server = fakeServer();
    server.on("/api/command/undo", () => json({ undo: null }));
    host = fakeHost();
  });

  const tab = {
    id: "tab-1",
    userId: "u-1",
    workspaceId: "w-kyoto",
    url: "https://airline.example/booking/osaka",
    title: "Flight booking: Osaka KIX",
    snippet: "NH 6",
    chromeTabId: 42,
    placementSource: "user" as const,
    lastSeenAt: "2026-09-20T12:00:00.000Z",
    createdAt: "2026-09-20T12:00:00.000Z",
  };
  const found: CommandReply = {
    kind: "found",
    understood: "Looking for your tabs matching that.",
    tabs: [{ tab, workspaceName: "Kyoto trip" }],
    workspaces: [{ workspace: { id: "w-cook", userId: "u-1", name: "Cooking", emoji: null, status: "active", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }, tabCount: 2 }],
    more: 1,
    cutNote: null,
  };

  it("reaches the found answer with no apply call and no changed signal", async () => {
    server.on("/api/command", () => json(found));
    const c = createCommandController({ config, host, fetchImpl: server.fetchImpl });
    await c.submit("find my flight tab");
    expect(c.getState().view).toMatchObject({ kind: "found", more: 1, understood: "Looking for your tabs matching that." });
    expect(server.calls.filter((call) => call.path === "/api/command/apply")).toEqual([]);
    expect(host.refreshed).toBe(0);
    expect(mock.session.get(SIGNAL_KEY)).toBeUndefined();
    expect(isBusy(c.getState().view)).toBe(false);
  });

  it("opening a match is the host's job: one openTab for a tab, one showHome for a workspace", async () => {
    server.on("/api/command", () => json(found));
    const c = createCommandController({ config, host, fetchImpl: server.fetchImpl });
    await c.submit("find my flight tab");
    expect(c.getState().view.kind).toBe("found");
    await host.openTab(tab);
    expect(host.opened).toEqual([tab]);
    await host.showHome({ kind: "workspace", workspaceId: "w-cook" });
    expect(host.homes).toEqual([{ kind: "workspace", workspaceId: "w-cook" }]);
  });
});
