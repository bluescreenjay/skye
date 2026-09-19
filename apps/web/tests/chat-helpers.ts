// Helpers for the workspace-chat tests: a fake chat model (no network, ever) that follows a
// script, a gate that holds it open, and seeding through the real routes, plus small wrappers
// that call the chat route handlers the way a client would.
import { GET as chatGet, POST as chatPost } from "@/app/api/workspaces/[id]/chat/route";
import { PATCH as tabRefPatch } from "@/app/api/tab-refs/[id]/route";
import { ensureUser } from "@/src/auth";
import { query } from "@/src/db";
import { setChatModelForTests, type ChatModel, type ChatModelInput } from "@/src/chat/model";
import { resetForTests as resetBudget } from "@/src/llm/budget";
import { resetLimiterForTests } from "@/src/llm/limiter";
import { read, req } from "./helpers";
import { makeWorkspace as makeWorkspaceFor, seedTabs, type SeedTab } from "./cluster-helpers";

export { seedTabs };

/** A promise a test releases later, to hold a fake model open. */
export function gate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

/** What the fake model does for one call. */
export interface ChatScript {
  /** The pieces to stream, in order. */
  pieces?: string[];
  /** Wait this long before each piece after the first. */
  delayMs?: number;
  /** Throw this before the first piece (the "AI service is down" case). */
  failBefore?: Error;
  /** Throw this after `pieces` pieces have been sent (the "stream broke" case). */
  failAfter?: { pieces: number; error: Error };
  /** Wait for this before the first piece. */
  hold?: Promise<void>;
  /** Wait for `until` once `pieces` pieces have been sent (a reply that is open mid-way). */
  holdAfter?: { pieces: number; until: Promise<void> };
}

/** What the fake saw for one call. */
export interface ChatCall extends ChatModelInput {
  /** True when the call was cut short: its signal aborted or its consumer stopped early. */
  stopped: boolean;
  /** True when every piece was sent. */
  finished: boolean;
}

export interface FakeChatModel extends ChatModel {
  calls: ChatCall[];
}

type ScriptOrFn = ChatScript | ((input: ChatModelInput, callNumber: number) => ChatScript);

/** Waits for `what` (a time in ms, or a promise), returning early if the signal aborts. */
function until(what: number | Promise<void>, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      signal?.removeEventListener("abort", done);
      resolve();
    };
    signal?.addEventListener("abort", done, { once: true });
    if (typeof what === "number") setTimeout(done, what);
    else what.then(done, done);
  });
}

/** A chat model that follows `script`, records every call, and stops promptly when aborted. */
export function fakeChatModel(script: ScriptOrFn): FakeChatModel {
  const calls: ChatCall[] = [];
  return {
    calls,
    async *stream(input, signal) {
      const call: ChatCall = { system: input.system, messages: input.messages.map((m) => ({ ...m })), stopped: false, finished: false };
      calls.push(call);
      const plan = typeof script === "function" ? script(input, calls.length) : script;
      const pieces = plan.pieces ?? [];
      try {
        if (plan.failBefore) throw plan.failBefore;
        if (plan.hold) await until(plan.hold, signal);
        for (let i = 0; i < pieces.length; i += 1) {
          if (signal?.aborted) return;
          if (i > 0 && plan.delayMs) await until(plan.delayMs, signal);
          if (signal?.aborted) return;
          if (plan.failAfter && i === plan.failAfter.pieces) throw plan.failAfter.error;
          yield pieces[i];
          if (plan.holdAfter && i + 1 === plan.holdAfter.pieces) await until(plan.holdAfter.until, signal);
        }
        if (signal?.aborted) return;
        if (plan.failAfter && plan.failAfter.pieces >= pieces.length) throw plan.failAfter.error;
        call.finished = true;
      } finally {
        if (!call.finished) call.stopped = true;
      }
    },
  };
}

/** Installs a fake chat model for the current test and resets the daily budget and the concurrency limiter. */
export function installFakeChatModel(script: ScriptOrFn): FakeChatModel {
  resetBudget();
  resetLimiterForTests();
  const model = fakeChatModel(script);
  setChatModelForTests(model);
  return model;
}

/** Call in afterEach: puts the real model (which has no key in tests) back. */
export function restoreChatModel(): void {
  setChatModelForTests(null);
  resetBudget();
  resetLimiterForTests();
}

/** Creates a workspace by hand for this token's user (the user is created first if it is new). */
export async function makeWorkspace(token: string, name: string, emoji: string | null = null) {
  await userIdOf(token);
  return makeWorkspaceFor(token, name, emoji);
}

/** The id of the user a device token belongs to (created on first use). */
export async function userIdOf(token: string): Promise<string> {
  const user = await ensureUser(token);
  if (!user) throw new Error("userIdOf: token too short");
  return user.id;
}

/**
 * Puts tabs into a workspace through the real ingest and tab-ref routes and returns them.
 * Each tab's title and snippet default to text that names its address, so a test can tell tabs apart.
 */
export async function putTabsIn(token: string, workspaceId: string, tabs: SeedTab[]) {
  const all = await seedTabs(token, tabs);
  const placed = [];
  for (const wanted of tabs) {
    const found = all.find((t) => t.url === wanted.url);
    if (!found) throw new Error(`putTabsIn: ${wanted.url} was not stored`);
    const reply = await read(
      tabRefPatch(req("PATCH", `/api/tab-refs/${found.id}`, token, { workspaceId }), { params: Promise.resolve({ id: found.id }) }),
    );
    if (reply.status !== 200) throw new Error(`putTabsIn failed: ${reply.status} ${JSON.stringify(reply.json)}`);
    placed.push(found);
  }
  return placed;
}

/** Adds a plan item directly with SQL (there is no route for plan items yet). */
export async function addPlanItem(userId: string, workspaceId: string, text: string, done = false, sortOrder = 0) {
  await query(
    `INSERT INTO plan_items (id, user_id, workspace_id, text, done, sort_order)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)`,
    [crypto.randomUUID(), userId, workspaceId, text, done, sortOrder],
  );
}

/** Adds a message directly with SQL, with an explicit time so an order can be set up exactly. */
export async function addMessageAt(userId: string, workspaceId: string, role: "user" | "assistant" | "system", content: string, at: Date) {
  const result = await query<{ id: string }>(
    `INSERT INTO messages (id, user_id, workspace_id, role, content, created_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz) RETURNING id`,
    [crypto.randomUUID(), userId, workspaceId, role, content, at.toISOString()],
  );
  return result.rows[0].id;
}

/** How many messages this workspace has. */
export async function countMessages(workspaceId: string): Promise<number> {
  const result = await query<{ n: string }>("SELECT count(*) AS n FROM messages WHERE workspace_id = $1::uuid", [workspaceId]);
  return Number(result.rows[0].n);
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** POST /api/workspaces/:id/chat in JSON mode (`stream: false`), unless the body says otherwise. */
export function sendChat(token: string | null, workspaceId: string, body: Record<string, unknown> = {}) {
  return read(chatPost(req("POST", `/api/workspaces/${workspaceId}/chat`, token, { stream: false, ...body }), ctx(workspaceId)));
}

/** GET /api/workspaces/:id/chat with an optional query string such as "?limit=10&before=<id>". */
export function getHistory(token: string | null, workspaceId: string, queryString = "") {
  return read(chatGet(req("GET", `/api/workspaces/${workspaceId}/chat${queryString}`, token), ctx(workspaceId)));
}

/** POST to the chat route and return the raw Response (a stream unless the body says `stream: false`). */
export function streamChat(token: string | null, workspaceId: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Response> {
  const request = new Request(`http://localhost/api/workspaces/${workspaceId}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal,
  });
  return Promise.resolve(chatPost(request, ctx(workspaceId)));
}

export interface SseEvent {
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

/** Reads an event stream one event at a time, so a test can look at the first events while the reply is still being written. */
export function eventReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pending: SseEvent[] = [];

  const parse = () => {
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) pending.push({ event, data: JSON.parse(data) });
    }
  };

  return {
    /** The next event, or undefined when the stream has ended. */
    async next(): Promise<SseEvent | undefined> {
      while (pending.length === 0) {
        const { done, value } = await reader.read();
        if (done) return undefined;
        buffer += decoder.decode(value, { stream: true });
        parse();
      }
      return pending.shift();
    },
    async all(): Promise<SseEvent[]> {
      const events: SseEvent[] = [];
      for (let e = await this.next(); e; e = await this.next()) events.push(e);
      return events;
    },
    /** What a client does when the person closes the panel. */
    cancel: () => reader.cancel(),
  };
}

/** Waits (briefly) until `check` is true, for effects that follow an abort. */
export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error("eventually: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
