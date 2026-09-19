import { describe, expect, it, vi } from "vitest";
import type { Message } from "@ai-browser/shared";
import { contextLabel, createSseParser, readHistory, sendChat, statusMessage, toLines } from "../src/home/chat";

const CONFIG = { apiBaseUrl: "http://127.0.0.1:3000", deviceToken: "test-token-not-real" };
const WS = "3458835e-32f1-4dec-a537-f9b4acbbe662";
const enc = new TextEncoder();

const msg = (id: string, role: Message["role"], content: string): Message => ({
  id,
  userId: "u1",
  workspaceId: WS,
  role,
  content,
  createdAt: "2026-09-19T12:00:00.000Z",
});
const INFO = { tabsIncluded: 9, tabsTotal: 9, planItemsIncluded: 0, messagesIncluded: 1 };

const block = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const meta = (userMessage = msg("m1", "user", "hi")) => block("meta", { userMessage, contextInfo: INFO });
const delta = (text: string) => block("delta", { text });
const done = (text: string) => block("done", { assistantMessage: msg("m2", "assistant", text) });

/** A stream response whose body is handed out one chunk per read, then closes, hangs, or breaks. */
function streamOf(chunks: (string | Uint8Array)[], then: "close" | "error" | "hang" = "close", cancelled?: { value: boolean }) {
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < chunks.length) {
        const chunk = chunks[next++];
        controller.enqueue(typeof chunk === "string" ? enc.encode(chunk) : chunk);
      } else if (then === "close") controller.close();
      else if (then === "error") controller.error(new Error("socket reset"));
      else return new Promise<void>(() => undefined);
      return undefined;
    },
    cancel() {
      if (cancelled) cancelled.value = true;
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchOf = (response: Response | (() => Response)) =>
  vi.fn(async () => (typeof response === "function" ? response() : response)) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe("createSseParser", () => {
  it("returns whole events and holds a partial one until the rest arrives", () => {
    const parser = createSseParser();
    expect(parser.push('event: delta\ndata: {"text":"He')).toEqual([]);
    expect(parser.push('llo"}\n\nevent: delta\ndata: {"text":" there"}\n')).toEqual([{ event: "delta", data: { text: "Hello" } }]);
    expect(parser.push("\n")).toEqual([{ event: "delta", data: { text: " there" } }]);
  });

  it("accepts \\r\\n, comments, and an unknown block that is not JSON", () => {
    const parser = createSseParser();
    const events = parser.push(': ping\r\n\r\nevent: delta\r\ndata: {"text":"a"}\r\n\r\nevent: x\r\ndata: not json\r\n\r\n');
    expect(events).toEqual([{ event: "delta", data: { text: "a" } }]);
  });
});

describe("sendChat: a reply that streams", () => {
  it("posts the message with the bearer token, streaming by default, and reports meta, pieces, then done", async () => {
    const fetchImpl = fetchOf(() => streamOf([meta(), delta("You "), delta("have "), delta("nine tabs."), done("You have nine tabs.")]));
    const onMeta = vi.fn();
    const pieces: string[] = [];
    const outcome = await sendChat(CONFIG, WS, { message: "hi" }, { onMeta, onDelta: (t) => pieces.push(t) }, { fetchImpl });

    expect(outcome).toMatchObject({ kind: "done", contextInfo: INFO });
    expect(outcome.kind === "done" && outcome.assistantMessage.content).toBe("You have nine tabs.");
    expect(pieces.join("")).toBe("You have nine tabs.");
    expect(onMeta).toHaveBeenCalledWith({ userMessage: msg("m1", "user", "hi"), contextInfo: INFO });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:3000/api/workspaces/${WS}/chat`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token-not-real");
    expect(JSON.parse(init.body as string)).toEqual({ message: "hi" }); // no `stream: false`: streaming is the default
    expect(url).not.toContain("test-token");
  });

  it("sends { retry: true } as the whole body for a retry", async () => {
    const fetchImpl = fetchOf(() => streamOf([meta(), delta("ok"), done("ok")]));
    await sendChat(CONFIG, WS, { retry: true }, {}, { fetchImpl });
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ retry: true });
  });

  it("reads events split across chunks, even inside a multi-byte character", async () => {
    const bytes = enc.encode(delta("café \u{1F375}") + done("café \u{1F375}"));
    const cut = bytes.indexOf(0xf0) + 2; // in the middle of the emoji
    const fetchImpl = fetchOf(() => streamOf([enc.encode(meta()), bytes.slice(0, cut), bytes.slice(cut)]));
    const pieces: string[] = [];
    const outcome = await sendChat(CONFIG, WS, { message: "x" }, { onDelta: (t) => pieces.push(t) }, { fetchImpl });
    expect(outcome.kind).toBe("done");
    expect(pieces).toEqual(["café \u{1F375}"]);
  });

  it("an error event is an interrupted reply, and the person's saved message comes back so Retry can be offered", async () => {
    const fetchImpl = fetchOf(() =>
      streamOf([meta(), delta("Half of an "), block("error", { code: "interrupted", message: "The answer was interrupted." })]),
    );
    const outcome = await sendChat(CONFIG, WS, { message: "hi" }, {}, { fetchImpl });
    expect(outcome).toEqual({ kind: "interrupted", userMessage: msg("m1", "user", "hi") });
  });

  it("a connection that drops with no done and no error is also interrupted", async () => {
    const closed = await sendChat(CONFIG, WS, { message: "hi" }, {}, { fetchImpl: fetchOf(() => streamOf([meta(), delta("part")])) });
    expect(closed.kind).toBe("interrupted");
    const broken = await sendChat(CONFIG, WS, { message: "hi" }, {}, { fetchImpl: fetchOf(() => streamOf([meta(), delta("part")], "error")) });
    expect(broken).toEqual({ kind: "interrupted", userMessage: msg("m1", "user", "hi") });
  });
});

describe("sendChat: refused or failed before any text", () => {
  it.each([
    [502, "model_error", "The AI assistant couldn't answer right now. Your message is saved. Try again in a moment."],
    [429, "budget_exhausted", "The daily AI limit has been reached. Your message is saved."],
  ])("HTTP %i %s carries the server's own sentence and the saved message", async (status, code, error) => {
    const saved = msg("m9", "user", "hello");
    const outcome = await sendChat(CONFIG, WS, { message: "hello" }, {}, { fetchImpl: fetchOf(json(status, { error, code, userMessage: saved })) });
    expect(outcome).toEqual({ kind: "failed", status, code, message: error, userMessage: saved });
  });

  it("a refusal that saved nothing has no userMessage (409 reply_in_progress, 503, 400)", async () => {
    for (const [status, code] of [[409, "reply_in_progress"], [503, "model_unconfigured"], [400, "message_too_long"]] as const) {
      const outcome = await sendChat(CONFIG, WS, { message: "x" }, {}, { fetchImpl: fetchOf(json(status, { error: `e${status}`, code })) });
      expect(outcome).toEqual({ kind: "failed", status, code, message: `e${status}`, userMessage: null });
    }
  });

  it("401 and 404 from the app's shared errors (no code) get plain fallback sentences", async () => {
    const unauthorized = await sendChat(CONFIG, WS, { message: "x" }, {}, { fetchImpl: fetchOf(json(401, {})) });
    expect(unauthorized).toMatchObject({ kind: "failed", status: 401, code: null, message: statusMessage(401) });
    expect(statusMessage(401)).toContain("pairing");
    const missing = await sendChat(CONFIG, WS, { message: "x" }, {}, { fetchImpl: fetchOf(json(404, { error: "Workspace not found" })) });
    expect(missing).toMatchObject({ status: 404, message: "Workspace not found" });
  });

  it("a body that is not JSON still gives a message", async () => {
    const outcome = await sendChat(CONFIG, WS, { message: "x" }, {}, { fetchImpl: fetchOf(new Response("<html>bad gateway</html>", { status: 502 })) });
    expect(outcome).toMatchObject({ kind: "failed", status: 502, code: null, message: statusMessage(502), userMessage: null });
    expect(JSON.stringify(outcome)).not.toContain("html");
  });

  it("an unreachable server is status 0", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await sendChat(CONFIG, WS, { message: "x" }, {}, { fetchImpl })).toEqual({
      kind: "failed",
      status: 0,
      code: null,
      message: "could not reach the server",
      userMessage: null,
    });
  });
});

describe("sendChat: stopping", () => {
  it("aborting mid-stream ends quietly as aborted and cancels the body", async () => {
    const cancelled = { value: false };
    const controller = new AbortController();
    const fetchImpl = fetchOf(() => streamOf([meta(), delta("first ")], "hang", cancelled));
    const running = sendChat(CONFIG, WS, { message: "hi" }, { onDelta: () => controller.abort() }, { fetchImpl, signal: controller.signal });
    await expect(running).resolves.toEqual({ kind: "aborted" });
    expect(cancelled.value).toBe(true);
  });

  it("an abort before the response arrives is aborted, not a failure", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    expect(await sendChat(CONFIG, WS, { message: "x" }, {}, { fetchImpl, signal: controller.signal })).toEqual({ kind: "aborted" });
  });
});

describe("readHistory", () => {
  it("reads the newest page with hasMore, unanswered, and replying", async () => {
    const page = { messages: [msg("a", "user", "hi"), msg("b", "assistant", "hello")], hasMore: true, replying: false, unansweredMessageId: null };
    const fetchImpl = fetchOf(json(200, page));
    expect(await readHistory(CONFIG, WS, { fetchImpl })).toEqual(page);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(`http://127.0.0.1:3000/api/workspaces/${WS}/chat?limit=50`);
  });

  it("is null when the server refuses, is unreachable, or answers something unexpected", async () => {
    expect(await readHistory(CONFIG, WS, { fetchImpl: fetchOf(json(404, { error: "Workspace not found" })) })).toBeNull();
    expect(await readHistory(CONFIG, WS, { fetchImpl: fetchOf(json(200, { nope: true })) })).toBeNull();
    const down = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await readHistory(CONFIG, WS, { fetchImpl: down })).toBeNull();
  });
});

describe("toLines and contextLabel", () => {
  it("labels rows you and skye and never shows system messages", () => {
    expect(toLines([msg("1", "user", "q"), msg("2", "system", "hidden"), msg("3", "assistant", "a")])).toEqual([
      { id: "1", who: "you", text: "q" },
      { id: "3", who: "skye", text: "a" },
    ]);
  });

  it("says what the answer covers", () => {
    expect(contextLabel({ ...INFO })).toBe("based on 9 of 9 tabs");
    expect(contextLabel({ ...INFO, tabsIncluded: 40, tabsTotal: 60 })).toBe("based on 40 of 60 tabs");
    expect(contextLabel({ ...INFO, tabsIncluded: 1, tabsTotal: 1 })).toBe("based on 1 of 1 tab");
    expect(contextLabel({ ...INFO, tabsIncluded: 0, tabsTotal: 0 })).toBe("no tabs in this workspace yet");
  });
});
