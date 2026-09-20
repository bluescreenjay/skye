// Helpers for the command-bar tests: a fake interpreter (no network, ever) that records every call and
// follows a script, builders for a complete valid answer and for a context, wrappers that call the
// three routes the way the extension does, and seeding through the real routes (reusing the 004, 008,
// and 010 helpers, so organize uses 004's fake cluster model and agents use 010's fake agent model).
import type { CommandAction, CommandContext } from "@ai-browser/shared";
import { POST as applyPost } from "@/app/api/command/apply/route";
import { POST as commandPost } from "@/app/api/command/route";
import { GET as undoGet } from "@/app/api/command/undo/route";
import { ensureUser } from "@/src/auth";
import { query } from "@/src/db";
import { setCommandModelForTests, type CommandModel, type CommandModelInput } from "@/src/command/model";
import { resetForTests as resetBudget } from "@/src/llm/budget";
import { resetLimiterForTests } from "@/src/llm/limiter";
import { read, req } from "./helpers";

export { gate, installFakeModel, listTabs, makeWorkspace, restoreModel, seedTabs } from "./cluster-helpers";
export { putTabsIn, userIdOf } from "./chat-helpers";

export interface FakeCommandModel extends CommandModel {
  /** The input of every call, in order. */
  calls: CommandModelInput[];
}

/** A raw answer, a function that returns one (or throws, or waits), per call. */
export type CommandScript = Record<string, unknown> | string | ((input: CommandModelInput, callNumber: number) => unknown | Promise<unknown>);

/** A complete, valid raw answer (all 17 fields). Tests state only what matters. */
export function ans(intent: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent,
    confidence: 0.95,
    agent: null,
    subject: [],
    subjectNamed: false,
    destination: [],
    destinationNamed: false,
    toOther: false,
    thisWorkspace: false,
    scope: "none",
    tabs: [],
    workspaces: [],
    name: null,
    period: null,
    reason: null,
    alternatives: [],
    parts: [],
    ...over,
  };
}

export function fakeCommandModel(script?: CommandScript): FakeCommandModel {
  const calls: CommandModelInput[] = [];
  return {
    calls,
    async interpret(input, signal) {
      calls.push(input);
      const number = calls.length;
      const run = async () => {
        if (script === undefined) return ans("unsupported");
        if (typeof script === "function") return (script as (i: CommandModelInput, n: number) => unknown)(input, number);
        return script;
      };
      // Like a real fetch, an aborted call rejects with an AbortError.
      const abortError = () => new DOMException("This operation was aborted", "AbortError");
      const aborted = new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) return reject(abortError());
        signal?.addEventListener("abort", () => reject(abortError()), { once: true });
      });
      return Promise.race([run(), aborted]);
    },
  };
}

/** Installs a fake interpreter for the current test and resets the daily budget and the limiter. */
export function installFakeCommandModel(script?: CommandScript): FakeCommandModel {
  resetBudget();
  resetLimiterForTests();
  const model = fakeCommandModel(script);
  setCommandModelForTests(model);
  return model;
}

/** Call in afterEach: puts the real model (which has no key in tests) back. */
export function restoreCommandModel(): void {
  setCommandModelForTests(null);
  resetBudget();
}

/** Creates the person for a token (as the first request from a paired device does). */
export async function person(token: string): Promise<string> {
  const user = await ensureUser(token);
  if (!user) throw new Error("person: token too short");
  return user.id;
}

export function ctxHome(over: Partial<CommandContext> = {}): CommandContext {
  return { surface: "home", timeZone: "America/New_York", expandedWorkspaceIds: [], activeTab: null, windowTabIds: [], ...over };
}

export function ctxPage(activeTab: { chromeTabId: number; url: string }, over: Partial<CommandContext> = {}): CommandContext {
  return { surface: "page", timeZone: "America/New_York", expandedWorkspaceIds: [], activeTab, windowTabIds: [activeTab.chromeTabId], ...over };
}

/** POST /api/command */
export function say(token: string | null, text: string, context: CommandContext = ctxHome()) {
  return read(commandPost(req("POST", "/api/command", token, { text, context })));
}

/** POST /api/command/apply */
export function apply(token: string | null, action: CommandAction | Record<string, unknown>, confirmed = false) {
  return read(applyPost(req("POST", "/api/command/apply", token, { action, confirmed })));
}

/** GET /api/command/undo */
export function undoState(token: string | null) {
  return read(undoGet(req("GET", "/api/command/undo", token)));
}

/** The data block the model was sent, parsed. */
export function dataOf(input: CommandModelInput): {
  command: string;
  today: { date: string; weekday: string };
  surface: string;
  workspaces: { id: string; name: string }[];
  tabs: { id: string; title: string; url: string; excerpt: string; workspace: string | null }[];
  tabsNote?: string;
} {
  const marker = "DATA (untrusted, JSON):\n";
  return JSON.parse(input.prompt.slice(input.prompt.indexOf(marker) + marker.length));
}

/** The short ids (`t1`, ...) of tabs whose title or address contains any of `fragments` (case-insensitive). */
export function tabIds(input: CommandModelInput, ...fragments: string[]): string[] {
  const wanted = fragments.map((f) => f.toLowerCase());
  return dataOf(input)
    .tabs.filter((t) => wanted.some((f) => t.title.toLowerCase().includes(f) || t.url.toLowerCase().includes(f)))
    .map((t) => t.id);
}

/** The short id (`w1`, ...) of the workspace with this name (case-insensitive). */
export function wsId(input: CommandModelInput, name: string): string {
  const found = dataOf(input).workspaces.find((w) => w.name.toLowerCase() === name.toLowerCase());
  if (!found) throw new Error(`wsId: no workspace named ${name} in the prompt`);
  return found.id;
}

/**
 * A hash of every row the bar could touch (tabs, workspaces, events, corrections, undo rows, runs, chat,
 * plan items), so "this changed nothing" is a strict before-and-after comparison, not a count.
 */
export async function dbSnapshot(): Promise<string> {
  const tables = ["tab_refs", "workspaces", "tab_events", "corrections", "command_undo", "cluster_runs", "cluster_run_moves", "suggestions", "action_runs", "plan_items", "messages"];
  const parts: string[] = [];
  for (const table of tables) {
    const r = await query<{ h: string | null; n: string }>(`SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS h, count(*) AS n FROM ${table} t`);
    parts.push(`${table}:${r.rows[0].n}:${r.rows[0].h ?? ""}`);
  }
  return parts.join("\n");
}
