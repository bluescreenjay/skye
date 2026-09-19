import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetForTests as resetBudget, usage } from "@/src/llm/budget";
import { BudgetExceededError, ModelError, ModelUnconfiguredError } from "@/src/llm/errors";
import { geminiStreamText } from "@/src/llm/gemini";
import { streamText } from "@/src/llm/index";
import { limiterState, resetLimiterForTests } from "@/src/llm/limiter";
import { vtStreamText } from "@/src/llm/openai-compat";
import { readDataLines } from "@/src/llm/sse";
import { DEFAULT_CHAT_MAX_TOKENS, STREAM_TOTAL_MS, type StreamTextOptions } from "@/src/llm/types";

// ---- fake network: byte streams split at awkward places ---------------------------------------

const enc = new TextEncoder();

type Then = "close" | "hang" | "error";

/** A response body that hands out `chunks` one per read, then closes, hangs, or breaks. `state.cancelled` shows whether the consumer cancelled it. */
function bodyOf(chunks: (string | Uint8Array)[], then: Then = "close") {
  const state = { cancelled: false };
  let next = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < chunks.length) {
        const chunk = chunks[next++];
        controller.enqueue(typeof chunk === "string" ? enc.encode(chunk) : chunk);
        return undefined;
      }
      if (then === "close") controller.close();
      else if (then === "error") controller.error(new Error("socket reset: secret-server-body"));
      else return new Promise<void>(() => undefined); // hang: no more data, no end
      return undefined;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

const ok = (chunks: (string | Uint8Array)[], then: Then = "close") => {
  const { stream, state } = bodyOf(chunks, then);
  return { response: new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }), state };
};
const failure = (status: number, body: unknown = "server body that must never leak") =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const BUSY = () => failure(400, { detail: "concurrent session limit reached" });

/** VT / OpenAI-style events. */
const vtDelta = (content: string, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content, ...extra } }] })}\n\n`;
const vtReasoning = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: text } }] })}\n\n`;
const DONE = "data: [DONE]\n\n";

/** Gemini events. */
const gemPart = (parts: unknown[], finishReason?: string) =>
  `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }] })}\n\n`;

async function drain(generator: AsyncGenerator<string, void, void>) {
  const pieces: string[] = [];
  let error: unknown;
  try {
    for await (const piece of generator) pieces.push(piece);
  } catch (caught) {
    error = caught;
  }
  return { pieces, error };
}

const noSleep = vi.fn(async (_ms: number) => undefined);
const TURNS: StreamTextOptions["messages"] = [
  { role: "user", content: "what did we decide?" },
  { role: "assistant", content: "We picked the second option." },
  { role: "user", content: "and what is next?" },
];
const options = (fetchImpl: unknown, extra: Partial<StreamTextOptions> = {}): StreamTextOptions => ({
  purpose: "chat",
  system: "the rules and the workspace data",
  messages: TURNS,
  fetchImpl: fetchImpl as typeof fetch,
  sleep: noSleep,
  ...extra,
});
const vt = (fetchImpl: unknown, extra: Partial<StreamTextOptions> = {}) => vtStreamText(options(fetchImpl, extra));
const gemini = (fetchImpl: unknown, extra: Partial<StreamTextOptions> = {}) => geminiStreamText(options(fetchImpl, extra));
const vtActive = () => limiterState()["gpt-oss-120b"]?.active ?? 0;

const saved = { ...process.env };
beforeEach(() => {
  resetBudget();
  resetLimiterForTests();
  noSleep.mockClear();
  for (const name of ["LLM_MODEL", "LLM_BASE_URL", "LLM_API_KEY", "LLM_CONCURRENCY", "LLM_DAILY_CAP", "LLM_PROVIDER", "GEMINI_MODEL", "GEMINI_THINKING_LEVEL"]) {
    delete process.env[name];
  }
  for (const purpose of ["CLUSTER", "CHAT", "PLAN", "ACTIONS", "COMMAND"]) {
    delete process.env[`LLM_MODEL_${purpose}`];
    delete process.env[`GEMINI_MODEL_${purpose}`];
  }
  process.env.VT_LLM_API_KEY = "test-vt-key-not-real";
  process.env.GEMINI_API_KEY = "test-gemini-key-not-real";
});
afterEach(() => {
  vi.useRealTimers();
  process.env = { ...saved };
  resetBudget();
  resetLimiterForTests();
});

// ---- the server-sent-events reader ------------------------------------------------------------

describe("SSE reader", () => {
  const read = async (chunks: (string | Uint8Array)[]) => {
    const out: string[] = [];
    for await (const payload of readDataLines(bodyOf(chunks).stream)) out.push(payload);
    return out;
  };

  it("joins a line split across chunks, accepts \\r\\n, and skips blank, comment, and event lines", async () => {
    expect(await read(["da", "ta: one\r\n\r", "\n: a comment\n", "event: ping\ndata: two\n\n", "data:three\n", "\n\n", DONE])).toEqual([
      "one",
      "two",
      "three",
      "[DONE]",
    ]);
  });

  it("yields a last line that has no trailing newline", async () => {
    expect(await read(["data: first\n\n", "data: last"])).toEqual(["first", "last"]);
  });

  it("keeps a multi-byte character that is split across two chunks", async () => {
    const bytes = enc.encode(vtDelta("a\u{1F642}b héllo"));
    const at = bytes.indexOf(0xf0) + 2; // in the middle of the 4-byte emoji
    const payloads = await read([bytes.slice(0, at), bytes.slice(at)]);
    expect(JSON.parse(payloads[0]).choices[0].delta.content).toBe("a\u{1F642}b héllo");
  });

  it("cancels the body when the reader stops early", async () => {
    const { stream, state } = bodyOf(["data: one\n\n", "data: two\n\n"], "hang");
    for await (const payload of readDataLines(stream)) {
      expect(payload).toBe("one");
      break;
    }
    expect(state.cancelled).toBe(true);
  });
});

// ---- VT / OpenAI-compatible streaming ---------------------------------------------------------

describe("VT stream: the request and the pieces", () => {
  it("posts stream:true with the system message first, then the turns, on the chat model", async () => {
    const fetchImpl = vi.fn(async () => ok([vtDelta("Hi"), DONE]).response);
    await drain(vt(fetchImpl));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://llm-api.arc.vt.edu/api/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-vt-key-not-real");
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({ model: "gpt-oss-120b-thinking-low", stream: true, max_tokens: DEFAULT_CHAT_MAX_TOKENS });
    expect(sent.messages).toEqual([{ role: "system", content: "the rules and the workspace data" }, ...TURNS]);
    expect(url).not.toContain("test-vt-key");
    expect(init.body as string).not.toContain("test-vt-key");
  });

  it("honours maxTokens and LLM_MODEL_CHAT", async () => {
    process.env.LLM_MODEL_CHAT = "chat-model";
    const fetchImpl = vi.fn(async () => ok([vtDelta("Hi"), DONE]).response);
    await drain(vt(fetchImpl, { maxTokens: 300 }));
    const sent = JSON.parse(((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string));
    expect(sent).toMatchObject({ model: "chat-model", max_tokens: 300 });
  });

  it("yields the text pieces in order and ignores reasoning", async () => {
    const fetchImpl = vi.fn(
      async () => ok([vtReasoning("thinking hard"), vtDelta("We "), vtReasoning("more"), vtDelta("decided "), vtDelta("B."), DONE]).response,
    );
    const { pieces, error } = await drain(vt(fetchImpl));
    expect(error).toBeUndefined();
    expect(pieces).toEqual(["We ", "decided ", "B."]);
  });

  it("ends on a finish_reason even with no [DONE], and skips empty deltas", async () => {
    const finish = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`;
    const fetchImpl = vi.fn(async () => ok([vtDelta(""), vtDelta("ok"), finish], "hang").response);
    const { pieces, error } = await drain(vt(fetchImpl));
    expect(error).toBeUndefined();
    expect(pieces).toEqual(["ok"]);
  });

  it("nothing is sent until the first next()", async () => {
    const fetchImpl = vi.fn(async () => ok([vtDelta("x"), DONE]).response);
    const generator = vt(fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(usage().total).toBe(0);
    await generator.return(undefined);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("with no key: ModelUnconfiguredError, nothing sent, nothing counted", async () => {
    delete process.env.VT_LLM_API_KEY;
    const fetchImpl = vi.fn();
    const { error } = await drain(vt(fetchImpl));
    expect(error).toBeInstanceOf(ModelUnconfiguredError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(usage().total).toBe(0);
  });

  it("an already-aborted signal sends nothing", async () => {
    const fetchImpl = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const { pieces, error } = await drain(vt(fetchImpl, { signal: controller.signal }));
    expect(pieces).toEqual([]);
    expect(error).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("VT stream: failures before the first piece", () => {
  it("retries a busy 400, then streams; every attempt is counted", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => BUSY())
      .mockImplementationOnce(async () => BUSY())
      .mockImplementationOnce(async () => ok([vtDelta("late "), vtDelta("answer"), DONE]).response);
    const { pieces, error } = await drain(vt(fetchImpl));
    expect(error).toBeUndefined();
    expect(pieces).toEqual(["late ", "answer"]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(noSleep).toHaveBeenCalledTimes(2);
    expect(usage().byPurpose.chat).toBe(3);
    expect(vtActive()).toBe(0);
  });

  it("retries a 429 (on VT a 429 is at-capacity, not a quota)", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => failure(429, { error: { retry_after_s: 2 } }))
      .mockImplementationOnce(async () => ok([vtDelta("fine"), DONE]).response);
    const { pieces } = await drain(vt(fetchImpl));
    expect(pieces).toEqual(["fine"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(noSleep.mock.calls[0][0]).toBe(2000); // the service's own hint
  });

  it("gives up after six busy answers with a busy message, never the body", async () => {
    const fetchImpl = vi.fn(async () => BUSY());
    const { pieces, error } = await drain(vt(fetchImpl));
    expect(pieces).toEqual([]);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as Error).message).toMatch(/busy/i);
    expect((error as Error).message).not.toContain("concurrent session");
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(usage().total).toBe(6);
    expect(vtActive()).toBe(0);
  });

  it("retries one gateway hiccup, then a second one is a ModelError", async () => {
    const once = vi
      .fn()
      .mockImplementationOnce(async () => failure(503))
      .mockImplementationOnce(async () => ok([vtDelta("back"), DONE]).response);
    expect((await drain(vt(once))).pieces).toEqual(["back"]);
    expect(once).toHaveBeenCalledTimes(2);

    resetBudget();
    const twice = vi.fn(async () => failure(502));
    const { error } = await drain(vt(twice));
    expect(error).toBeInstanceOf(ModelError);
    expect(twice).toHaveBeenCalledTimes(2);
    expect(vtActive()).toBe(0);
  });

  it("the VPN 403 has the VPN message", async () => {
    const fetchImpl = vi.fn(async () => failure(403, { detail: "This API is restricted to the VT Campus VPN" }));
    const { error } = await drain(vt(fetchImpl));
    expect(error).toBeInstanceOf(ModelError);
    expect((error as Error).message).toMatch(/VT VPN/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a rejected key, a missing model, and any other status get fixed messages that never contain the server body", async () => {
    for (const [status, pattern] of [
      [401, /API key/],
      [404, /is not available/],
      [500, /could not complete/],
      [418, /could not complete/],
    ] as const) {
      resetBudget();
      const { error } = await drain(vt(vi.fn(async () => failure(status))));
      expect(error).toBeInstanceOf(ModelError);
      expect((error as Error).message).toMatch(pattern);
      expect((error as Error).message).not.toContain("must never leak");
    }
  });

  it("a network failure is a ModelError", async () => {
    const { error } = await drain(
      vt(
        vi.fn(async () => {
          throw new TypeError("fetch failed: secret-host");
        }),
      ),
    );
    expect(error).toBeInstanceOf(ModelError);
    expect((error as Error).message).not.toContain("secret-host");
    expect(vtActive()).toBe(0);
  });

  it("an answer with no text is a ModelError", async () => {
    const { pieces, error } = await drain(vt(vi.fn(async () => ok([vtReasoning("only thoughts"), DONE]).response)));
    expect(pieces).toEqual([]);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as Error).message).toMatch(/empty/i);
    expect(vtActive()).toBe(0);
  });

  it("stops asking once the daily budget is spent, without sending that request", async () => {
    process.env.LLM_DAILY_CAP = "2";
    const fetchImpl = vi.fn(async () => BUSY());
    const { error } = await drain(vt(fetchImpl));
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(usage().total).toBe(2);
  });
});

describe("VT stream: after the first piece", () => {
  it("never retries: a stream that breaks throws once, fetch was called once", async () => {
    const fetchImpl = vi.fn(async () => ok([vtDelta("Half of an ")], "error").response);
    const { pieces, error } = await drain(vt(fetchImpl));
    expect(pieces).toEqual(["Half of an "]);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as Error).message).toMatch(/interrupted/i);
    expect((error as Error).message).not.toContain("secret-server-body");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(usage().total).toBe(1);
    expect(vtActive()).toBe(0);
  });

  it("a payload that is not JSON is an interruption, not a crash", async () => {
    const fetchImpl = vi.fn(async () => ok([vtDelta("ok "), "data: {not json\n\n", vtDelta("never")]).response);
    const { pieces, error } = await drain(vt(fetchImpl));
    expect(pieces).toEqual(["ok "]);
    expect(error).toBeInstanceOf(ModelError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a stream that just ends after a piece (no [DONE]) is complete", async () => {
    const { pieces, error } = await drain(vt(vi.fn(async () => ok([vtDelta("whole answer")]).response)));
    expect(error).toBeUndefined();
    expect(pieces).toEqual(["whole answer"]);
  });
});

describe("VT stream: the concurrency slot", () => {
  it("is held while streaming and released at the end", async () => {
    const gate = ok([vtDelta("one "), vtDelta("two"), DONE]);
    const generator = vt(vi.fn(async () => gate.response));
    expect(vtActive()).toBe(0);
    const first = await generator.next();
    expect(first).toEqual({ value: "one ", done: false });
    expect(vtActive()).toBe(1);
    expect((await generator.next()).value).toBe("two");
    expect(vtActive()).toBe(1);
    expect((await generator.next()).done).toBe(true);
    expect(vtActive()).toBe(0);
  });

  it("is released after an error", async () => {
    const { stream } = bodyOf([vtDelta("x")], "error");
    const generator = vt(vi.fn(async () => new Response(stream, { status: 200 })));
    await generator.next();
    expect(vtActive()).toBe(1);
    await expect(generator.next()).rejects.toBeInstanceOf(ModelError);
    expect(vtActive()).toBe(0);
  });

  it("is released, and the body cancelled, when the consumer stops with return()", async () => {
    const { response, state } = ok([vtDelta("a"), vtDelta("b")], "hang");
    const generator = vt(vi.fn(async () => response));
    await generator.next();
    expect(vtActive()).toBe(1);
    await generator.return(undefined);
    expect(vtActive()).toBe(0);
    expect(state.cancelled).toBe(true);
  });

  it("aborting the signal mid-stream stops it quietly, frees the slot, and cancels the body", async () => {
    const controller = new AbortController();
    const { response, state } = ok([vtDelta("first ")], "hang");
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return response;
    });
    const generator = vt(fetchImpl, { signal: controller.signal });
    expect((await generator.next()).value).toBe("first ");
    const pending = generator.next(); // waiting for more that never comes
    controller.abort();
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    expect(vtActive()).toBe(0);
    expect(state.cancelled).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a second stream waits for a slot when the family is full, and goes when one frees", async () => {
    process.env.LLM_CONCURRENCY = "1";
    const first = ok([vtDelta("one")], "hang");
    const second = ok([vtDelta("two"), DONE]);
    const fetchImpl = vi.fn().mockImplementationOnce(async () => first.response).mockImplementationOnce(async () => second.response);
    const a = vt(fetchImpl);
    await a.next();
    const b = vt(fetchImpl);
    const bFirst = b.next();
    await Promise.resolve();
    expect(limiterState()["gpt-oss-120b"]).toEqual({ active: 1, waiting: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await a.return(undefined);
    expect((await bFirst).value).toBe("two");
    await drain(b);
    expect(vtActive()).toBe(0);
  });
});

describe("VT stream: the deadlines", () => {
  it("a service that never sends a first piece fails at the first-byte deadline", async () => {
    vi.useFakeTimers();
    const { response, state } = ok([], "hang");
    const result = drain(vt(vi.fn(async () => response)));
    await vi.advanceTimersByTimeAsync(25_000);
    const { pieces, error } = await result;
    expect(pieces).toEqual([]);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as Error).message).toMatch(/did not respond in time/);
    expect(state.cancelled).toBe(true);
    expect(vtActive()).toBe(0);
  });

  it("the first-byte deadline is met by the first piece; the total cap then ends a hung stream", async () => {
    vi.useFakeTimers();
    const { response, state } = ok([vtDelta("started")], "hang");
    const result = drain(vt(vi.fn(async () => response)));
    await vi.advanceTimersByTimeAsync(30_000); // past the 25 s first-byte deadline: not an error now
    await vi.advanceTimersByTimeAsync(STREAM_TOTAL_MS - 30_000);
    const { pieces, error } = await result;
    expect(pieces).toEqual(["started"]);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as Error).message).toMatch(/interrupted/i);
    expect(state.cancelled).toBe(true);
    expect(vtActive()).toBe(0);
  });
});

// ---- Gemini streaming -------------------------------------------------------------------------

describe("Gemini stream", () => {
  it("posts to streamGenerateContent?alt=sse with systemInstruction and model-role turns", async () => {
    const fetchImpl = vi.fn(async () => ok([gemPart([{ text: "Hi" }], "STOP")]).response);
    await drain(gemini(fetchImpl));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-gemini-key-not-real");
    expect(url).not.toContain("test-gemini-key");
    const sent = JSON.parse(init.body as string);
    expect(sent.systemInstruction).toEqual({ parts: [{ text: "the rules and the workspace data" }] });
    expect(sent.contents).toEqual([
      { role: "user", parts: [{ text: "what did we decide?" }] },
      { role: "model", parts: [{ text: "We picked the second option." }] },
      { role: "user", parts: [{ text: "and what is next?" }] },
    ]);
    expect(sent.generationConfig).toMatchObject({ maxOutputTokens: DEFAULT_CHAT_MAX_TOKENS });
    expect(sent.generationConfig.thinkingConfig).toBeDefined();
    expect(init.body as string).not.toContain("test-gemini-key");
  });

  it("yields the text pieces and skips thought parts", async () => {
    const fetchImpl = vi.fn(
      async () =>
        ok([
          gemPart([{ text: "planning the answer", thought: true }]),
          gemPart([{ text: "The " }, { text: "team " }]),
          gemPart([{ text: "chose B." }], "STOP"),
        ]).response,
    );
    const { pieces, error } = await drain(gemini(fetchImpl));
    expect(error).toBeUndefined();
    expect(pieces).toEqual(["The team ", "chose B."]);
  });

  it("a 429 is never retried: BudgetExceededError, one request", async () => {
    const fetchImpl = vi.fn(async () => failure(429));
    const { error } = await drain(gemini(fetchImpl));
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as Error).message).not.toContain("must never leak");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
    expect(usage().total).toBe(1);
    expect(limiterState()["gemini-3.5-flash-lite"]?.active ?? 0).toBe(0);
  });

  it("retries a 503 once", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => failure(503))
      .mockImplementationOnce(async () => ok([gemPart([{ text: "ok" }], "STOP")]).response);
    expect((await drain(gemini(fetchImpl))).pieces).toEqual(["ok"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(usage().total).toBe(2);
  });

  it("a 404 names the model to set, and other statuses give the generic message", async () => {
    const missing = await drain(gemini(vi.fn(async () => failure(404))));
    expect((missing.error as Error).message).toContain("GEMINI_MODEL");
    resetBudget();
    const other = await drain(gemini(vi.fn(async () => failure(500))));
    expect(other.error).toBeInstanceOf(ModelError);
    expect((other.error as Error).message).not.toContain("must never leak");
  });

  it("never retries after a piece: a broken stream throws once", async () => {
    const fetchImpl = vi.fn(async () => ok([gemPart([{ text: "Partial " }])], "error").response);
    const { pieces, error } = await drain(gemini(fetchImpl));
    expect(pieces).toEqual(["Partial "]);
    expect(error).toBeInstanceOf(ModelError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(usage().total).toBe(1);
  });

  it("an answer with only thoughts is an empty answer", async () => {
    const { error } = await drain(gemini(vi.fn(async () => ok([gemPart([{ text: "hmm", thought: true }], "STOP")]).response)));
    expect(error).toBeInstanceOf(ModelError);
    expect((error as Error).message).toMatch(/empty/i);
  });

  it("holds the slot while streaming and frees it on return()", async () => {
    const { response, state } = ok([gemPart([{ text: "a" }]), gemPart([{ text: "b" }])], "hang");
    const generator = gemini(vi.fn(async () => response));
    await generator.next();
    expect(limiterState()["gemini-3.5-flash-lite"]?.active).toBe(1);
    await generator.return(undefined);
    expect(limiterState()["gemini-3.5-flash-lite"]?.active ?? 0).toBe(0);
    expect(state.cancelled).toBe(true);
  });

  it("with no key: ModelUnconfiguredError and nothing is sent", async () => {
    delete process.env.GEMINI_API_KEY;
    const fetchImpl = vi.fn();
    const { error } = await drain(gemini(fetchImpl));
    expect(error).toBeInstanceOf(ModelUnconfiguredError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---- the dispatcher ---------------------------------------------------------------------------

describe("streamText picks the provider", () => {
  it("uses VT by default and Gemini when LLM_PROVIDER=gemini", async () => {
    const vtFetch = vi.fn(async () => ok([vtDelta("from vt"), DONE]).response);
    expect((await drain(streamText(options(vtFetch)))).pieces).toEqual(["from vt"]);
    expect((vtFetch.mock.calls[0] as unknown as [string])[0]).toContain("llm-api.arc.vt.edu");

    process.env.LLM_PROVIDER = "gemini";
    const gemFetch = vi.fn(async () => ok([gemPart([{ text: "from gemini" }], "STOP")]).response);
    expect((await drain(streamText(options(gemFetch)))).pieces).toEqual(["from gemini"]);
    expect((gemFetch.mock.calls[0] as unknown as [string])[0]).toContain("generativelanguage.googleapis.com");
  });
});
