import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetForTests as resetBudget, usage } from "@/src/llm/budget";
import { BudgetExceededError, ModelError, ModelUnconfiguredError } from "@/src/llm/errors";
import { resetLimiterForTests } from "@/src/llm/limiter";
import { DEFAULT_MODELS, vtGenerateJson, vtModelFor } from "@/src/llm/openai-compat";

const SCHEMA = { type: "object", additionalProperties: false, required: ["groups"], properties: { groups: { type: "array", items: { type: "string" } } } };
const answer = (obj: unknown, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj), ...extra }, finish_reason: "stop" }] }), { status: 200 });
const reply = (status: number, body: unknown = "server body that must never leak") =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const BUSY = () => reply(400, { detail: "concurrent session limit reached" });

const saved = { ...process.env };
beforeEach(() => {
  resetBudget();
  resetLimiterForTests();
  for (const name of ["LLM_MODEL", "LLM_BASE_URL", "LLM_API_KEY", "LLM_CONCURRENCY", "LLM_DAILY_CAP", "LLM_PROVIDER"]) delete process.env[name];
  for (const purpose of ["CLUSTER", "CHAT", "PLAN", "ACTIONS", "COMMAND"]) delete process.env[`LLM_MODEL_${purpose}`];
  process.env.VT_LLM_API_KEY = "test-vt-key-not-real";
});
afterEach(() => {
  process.env = { ...saved };
  resetBudget();
  resetLimiterForTests();
});

const noSleep = vi.fn(async (_ms: number) => undefined);
const call = (fetchImpl: unknown, extra: Record<string, unknown> = {}) =>
  vtGenerateJson({ purpose: "cluster", prompt: "the prompt", schema: SCHEMA, fetchImpl: fetchImpl as typeof fetch, sleep: noSleep, ...extra });

describe("VT / OpenAI-compatible provider: the request", () => {
  it("posts to /chat/completions with a bearer key, strict json_schema, and the purpose's model", async () => {
    const fetchImpl = vi.fn(async () => answer({ groups: [] }));
    await expect(call(fetchImpl)).resolves.toEqual({ groups: [] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://llm-api.arc.vt.edu/api/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-vt-key-not-real");
    expect(url).not.toContain("test-vt-key");
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({ model: "gpt-oss-120b-thinking-low", temperature: 0.2, max_tokens: 4000 });
    expect(sent.messages).toEqual([{ role: "user", content: "the prompt" }]);
    expect(sent.response_format).toEqual({ type: "json_schema", json_schema: { name: "answer", schema: SCHEMA, strict: true } });
    expect(init.body as string).not.toContain("test-vt-key");
  });

  it("uses fast low-effort models for structured work and chat, and the medium model for actions", () => {
    expect(DEFAULT_MODELS).toEqual({
      cluster: "gpt-oss-120b-thinking-low",
      command: "gpt-oss-120b-thinking-low",
      suggest: "gpt-oss-120b-thinking-low",
      chat: "gpt-oss-120b-thinking-low",
      actions: "gpt-oss-120b",
    });
  });

  it("LLM_MODEL_<PURPOSE> beats LLM_MODEL beats the default", () => {
    expect(vtModelFor("chat")).toBe("gpt-oss-120b-thinking-low");
    process.env.LLM_MODEL = "general-model";
    expect(vtModelFor("chat")).toBe("general-model");
    process.env.LLM_MODEL_CHAT = "chat-model";
    expect(vtModelFor("chat")).toBe("chat-model");
    expect(vtModelFor("command")).toBe("general-model");
  });

  it("honours LLM_BASE_URL (trailing slash trimmed) and accepts LLM_API_KEY in place of VT_LLM_API_KEY", async () => {
    process.env.LLM_BASE_URL = "https://llm.example.test/v1/";
    delete process.env.VT_LLM_API_KEY;
    process.env.LLM_API_KEY = "other-key";
    const fetchImpl = vi.fn(async () => answer({ groups: [] }));
    await call(fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://llm.example.test/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer other-key");
  });

  it("with no key: ModelUnconfiguredError, nothing is sent, nothing is counted", async () => {
    delete process.env.VT_LLM_API_KEY;
    const fetchImpl = vi.fn();
    await expect(call(fetchImpl)).rejects.toBeInstanceOf(ModelUnconfiguredError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(usage().total).toBe(0);
  });

  it("a spent daily budget stops the call before any request is sent", async () => {
    process.env.LLM_DAILY_CAP = "0";
    const fetchImpl = vi.fn();
    await expect(call(fetchImpl)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("VT / OpenAI-compatible provider: reading the answer", () => {
  it("removes a wrapping code fence", async () => {
    const wrapped = new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"groups":["a"]}\n```' }, finish_reason: "stop" }] }), { status: 200 });
    await expect(call(async () => wrapped)).resolves.toEqual({ groups: ["a"] });
  });

  it("ignores the separate reasoning field", async () => {
    const fetchImpl = async () => answer({ groups: ["x"] }, { reasoning_content: "long private thoughts", reasoning: "more" });
    await expect(call(fetchImpl)).resolves.toEqual({ groups: ["x"] });
  });

  it("turns unreadable, empty, and cut-off answers into generic ModelErrors that leak nothing", async () => {
    const cases = [
      async () => new Response("not json at all", { status: 200 }),
      async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      async () => new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }), { status: 200 }),
      async () => new Response(JSON.stringify({ choices: [{ message: { content: "{not valid json" }, finish_reason: "stop" }] }), { status: 200 }),
      async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"groups":[' }, finish_reason: "length" }] }), { status: 200 }),
    ];
    for (const impl of cases) {
      const error = (await call(impl).catch((e) => e)) as Error;
      expect(error).toBeInstanceOf(ModelError);
      expect(error.message).not.toMatch(/not json|not valid|groups/);
    }
  });
});

describe("VT / OpenAI-compatible provider: a busy service is retried, not failed", () => {
  it("retries the 400 'concurrent session limit reached' with backoff and then succeeds; counts both attempts", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(BUSY()).mockResolvedValueOnce(BUSY()).mockResolvedValueOnce(answer({ groups: ["ok"] }));
    const sleep = vi.fn(async (_ms: number) => undefined);
    await expect(call(fetchImpl, { sleep })).resolves.toEqual({ groups: ["ok"] });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000]);
    expect(usage().total).toBe(3);
  });

  it("retries a 429, waiting for retry_after_s when the service says how long", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply(429, { error: { reason: "rate", retry_after_s: 2 } })).mockResolvedValueOnce(answer({ groups: [] }));
    const sleep = vi.fn(async (_ms: number) => undefined);
    await call(fetchImpl, { sleep });
    expect(sleep.mock.calls[0][0]).toBe(2000);
  });

  it("gives up after six attempts with a 'busy' BudgetExceededError, not a crash", async () => {
    const fetchImpl = vi.fn(async () => BUSY());
    const error = (await call(fetchImpl).catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(error.message).toContain("busy");
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("does not treat an ordinary 400 as busy", async () => {
    const fetchImpl = vi.fn(async () => reply(400, { detail: "messages must not be empty" }));
    await expect(call(fetchImpl)).rejects.toBeInstanceOf(ModelError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a 502/503/504 once, then gives up", async () => {
    const once = vi.fn().mockResolvedValueOnce(reply(503)).mockResolvedValueOnce(answer({ groups: [] }));
    await expect(call(once)).resolves.toEqual({ groups: [] });
    expect(once).toHaveBeenCalledTimes(2);
    const twice = vi.fn(async () => reply(502));
    await expect(call(twice)).rejects.toBeInstanceOf(ModelError);
    expect(twice).toHaveBeenCalledTimes(2);
  });

  it("falls back to plain JSON mode once if the strict schema is refused", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply(400, { detail: "Unsupported response_format: json_schema" }))
      .mockResolvedValueOnce(answer({ groups: ["fallback"] }));
    await expect(call(fetchImpl)).resolves.toEqual({ groups: ["fallback"] });
    const second = JSON.parse((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(second.response_format).toEqual({ type: "json_object" });
  });

  it("stops retrying when the budget runs out between attempts", async () => {
    process.env.LLM_DAILY_CAP = "1";
    const fetchImpl = vi.fn(async () => BUSY());
    await expect(call(fetchImpl)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("VT / OpenAI-compatible provider: errors that are not transient", () => {
  it("off the VPN: says so, names the fix, retries nothing, and does not echo the server's body", async () => {
    const fetchImpl = vi.fn(async () => reply(403, "API access is restricted to the VT Campus VPN. Please connect to the VPN and retry."));
    const error = (await call(fetchImpl).catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(ModelError);
    expect(error.message).toContain("VT VPN");
    expect(error.message).toContain("LLM_PROVIDER=gemini");
    expect(error.message).not.toContain("Please connect");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a rejected key is reported as such, without the key or the body", async () => {
    for (const status of [401, 403]) {
      const error = (await call(async () => reply(status, "Invalid API key sk-secret")).catch((e) => e)) as Error;
      expect(error).toBeInstanceOf(ModelError);
      expect(error.message).toBe("The AI service rejected the API key.");
    }
  });

  it("a missing model names it, so the fix is obvious", async () => {
    process.env.LLM_MODEL_CLUSTER = "no-such-model";
    const error = (await call(async () => reply(404)).catch((e) => e)) as Error;
    expect(error.message).toContain("no-such-model");
    expect(error.message).toContain("LLM_MODEL");
  });

  it("network errors and other HTTP errors are generic", async () => {
    for (const impl of [
      async () => {
        throw new TypeError("connection reset with secret details");
      },
      async () => reply(500, "stack trace secret"),
      async () => reply(422, "validation secret"),
    ]) {
      const error = (await call(impl).catch((e) => e)) as Error;
      expect(error).toBeInstanceOf(ModelError);
      expect(error.message).not.toMatch(/secret/);
    }
  });

  it("a caller's abort becomes a timeout ModelError", async () => {
    const controller = new AbortController();
    const fetchImpl = async (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        controller.abort();
      });
    const error = (await call(fetchImpl, { signal: controller.signal }).catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(ModelError);
    expect(error.message).toContain("in time");
  });
});

describe("VT / OpenAI-compatible provider: the local concurrency limiter", () => {
  it("never has more than 8 requests in flight for gpt-oss-120b (the limit is 10), and finishes them all", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      return answer({ groups: [] });
    };
    // three purposes on two variants of the same model family: they share one pool
    const calls = Array.from({ length: 24 }, (_, i) =>
      vtGenerateJson({ purpose: (["cluster", "chat", "actions"] as const)[i % 3], prompt: "p", schema: SCHEMA, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep }),
    );
    await expect(Promise.all(calls)).resolves.toHaveLength(24);
    expect(peak).toBe(8);
  });

  it("a request that cannot get a slot before its deadline fails as 'busy', without sending anything", async () => {
    process.env.LLM_CONCURRENCY = "1";
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = vi.fn(async () => {
      await held;
      return answer({ groups: [] });
    });
    const first = call(slow);
    await new Promise((r) => setTimeout(r, 10));
    const fetchImpl = vi.fn();
    const error = (await call(fetchImpl, { signal: AbortSignal.timeout(40) }).catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(error.message).toContain("busy");
    expect(fetchImpl).not.toHaveBeenCalled();
    release();
    await first;
  });
});

describe("VT provider: a per-call deadline (deadlineMs)", () => {
  it("ends a call that never answers at its own deadline, well before the default one", async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;
    const started = Date.now();
    await expect(
      vtGenerateJson({ purpose: "actions", prompt: "p", schema: SCHEMA, fetchImpl, sleep: noSleep, deadlineMs: 50 }),
    ).rejects.toBeInstanceOf(ModelError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
