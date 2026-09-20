import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DAILY_CAP, dailyCap, resetForTests, SHARES, spend, SPILL_OVER, usage } from "@/src/llm/budget";
import { BudgetExceededError, ModelError, ModelUnconfiguredError } from "@/src/llm/errors";
import { DEFAULT_MODEL, geminiGenerateJson as generateJson, geminiModelFor as modelFor } from "@/src/llm/gemini";

const SCHEMA = { type: "OBJECT", properties: {}, required: [] };
const ok = (obj: unknown) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), { status: 200 });
const status = (code: number, body = "vendor body that must never leak") => new Response(body, { status: code });

const saved = { ...process.env };
beforeEach(() => {
  resetForTests();
  process.env.GEMINI_API_KEY = "test-key-not-real";
  delete process.env.GEMINI_MODEL;
  delete process.env.LLM_DAILY_CAP;
});
afterEach(() => {
  process.env = { ...saved };
  resetForTests();
});

describe("daily AI-call budget (research section 18)", () => {
  it("defaults to a cap of 450 and ignores an invalid LLM_DAILY_CAP", () => {
    expect(dailyCap()).toBe(DEFAULT_DAILY_CAP);
    process.env.LLM_DAILY_CAP = "nonsense";
    expect(dailyCap()).toBe(DEFAULT_DAILY_CAP);
    process.env.LLM_DAILY_CAP = "12";
    expect(dailyCap()).toBe(12);
  });

  it("throws once the global cap is reached, and counts nothing when it throws", () => {
    process.env.LLM_DAILY_CAP = "2";
    spend("chat");
    spend("cluster");
    expect(() => spend("command")).toThrow(BudgetExceededError);
    expect(usage().total).toBe(2);
  });

  it("lets a purpose use its own share, then the spill-over pool, then stops", () => {
    for (let i = 0; i < SHARES.command; i += 1) spend("command");
    for (let i = 0; i < SPILL_OVER; i += 1) spend("command"); // draws on the shared pool
    expect(usage().byPurpose.command).toBe(SHARES.command + SPILL_OVER);
    expect(() => spend("command")).toThrow(BudgetExceededError);
    // Another purpose still has its own share left, but the shared pool is gone.
    spend("cluster");
    expect(usage().byPurpose.cluster).toBe(1);
  });

  it("starts a new count on a new Pacific-time day", () => {
    process.env.LLM_DAILY_CAP = "1";
    spend("chat", new Date("2026-09-19T12:00:00Z"));
    expect(() => spend("chat", new Date("2026-09-19T20:00:00Z"))).toThrow(BudgetExceededError);
    // 2026-09-20 03:00 UTC is still Sept 19 in Pacific; 08:00 UTC is Sept 20 (after midnight PDT).
    expect(() => spend("chat", new Date("2026-09-20T03:00:00Z"))).toThrow(BudgetExceededError);
    expect(() => spend("chat", new Date("2026-09-20T08:00:00Z"))).not.toThrow();
  });
});

describe("Gemini backup provider (llm/gemini.ts)", () => {
  const call = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
    generateJson({ purpose: "cluster", prompt: "p", schema: SCHEMA, fetchImpl, sleep: async () => undefined, ...extra });

  it("returns the parsed JSON answer and sends the key in a header, not the URL", async () => {
    const fetchImpl = vi.fn(async () => ok({ groups: [] }));
    await expect(call(fetchImpl as unknown as typeof fetch)).resolves.toEqual({ groups: [] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/models/${DEFAULT_MODEL}:generateContent`);
    expect(url).not.toContain("test-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key-not-real");
    const sent = JSON.parse(init.body as string);
    expect(sent.generationConfig.responseMimeType).toBe("application/json");
    expect(sent.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
  });

  it("uses GEMINI_MODEL_<PURPOSE>, then GEMINI_MODEL, then the default", () => {
    expect(modelFor("cluster")).toBe(DEFAULT_MODEL);
    process.env.GEMINI_MODEL = "general-model";
    expect(modelFor("cluster")).toBe("general-model");
    process.env.GEMINI_MODEL_CLUSTER = "cluster-model";
    expect(modelFor("cluster")).toBe("cluster-model");
    expect(modelFor("chat")).toBe("general-model");
  });

  it("has no key: ModelUnconfiguredError, and no request is counted or sent", async () => {
    process.env.GEMINI_API_KEY = "";
    const fetchImpl = vi.fn();
    await expect(call(fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(ModelUnconfiguredError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(usage().total).toBe(0);
  });

  it("never retries a 429: one request, BudgetExceededError, no vendor text leaked", async () => {
    const fetchImpl = vi.fn(async () => status(429));
    const error = (await call(fetchImpl as unknown as typeof fetch).catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(error.message).not.toContain("vendor body");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(usage().total).toBe(1);
  });

  it("retries a 503 once, and counts both attempts", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(status(503)).mockResolvedValueOnce(ok({ groups: [1] }));
    await expect(call(fetchImpl as unknown as typeof fetch)).resolves.toEqual({ groups: [1] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(usage().total).toBe(2);
  });

  it("gives up after a second 503 with a ModelError", async () => {
    const fetchImpl = vi.fn(async () => status(503));
    await expect(call(fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(ModelError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops retrying when the budget runs out between attempts", async () => {
    process.env.LLM_DAILY_CAP = "1";
    const fetchImpl = vi.fn(async () => status(503));
    await expect(call(fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("names the model on a 404 so the fix is obvious", async () => {
    const error = (await call((async () => status(404)) as unknown as typeof fetch).catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(ModelError);
    expect(error.message).toContain(DEFAULT_MODEL);
    expect(error.message).toContain("GEMINI_MODEL");
  });

  it("turns other HTTP errors, network errors, and unreadable answers into generic ModelErrors", async () => {
    for (const impl of [
      async () => status(500),
      async () => {
        throw new TypeError("connection reset by peer with secret details");
      },
      async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
      async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "not json {" }] } }] }), { status: 200 }),
    ]) {
      const error = (await call(impl as unknown as typeof fetch).catch((e) => e)) as Error;
      expect(error).toBeInstanceOf(ModelError);
      expect(error.message).not.toMatch(/secret|vendor body|not json/);
    }
  });

  it("skips thought parts when reading the answer", async () => {
    const answer = new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "thinking...", thought: true }, { text: '{"groups":[]}' }] } }] }),
      { status: 200 },
    );
    await expect(call((async () => answer) as unknown as typeof fetch)).resolves.toEqual({ groups: [] });
  });

  it("times out with a ModelError when the caller's signal aborts", async () => {
    const controller = new AbortController();
    const fetchImpl = (async (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        controller.abort();
      })) as unknown as typeof fetch;
    const error = (await call(fetchImpl, { signal: controller.signal }).catch((e) => e)) as Error;
    expect(error).toBeInstanceOf(ModelError);
    expect(error.message).toContain("in time");
  });
});

describe("feature 010: the plan purpose is gone and agents have their own share", () => {
  it("has five purposes, gives actions 120 and suggest 40, and the shares plus the spill-over pool add up to the daily cap", () => {
    expect(Object.keys(SHARES).sort()).toEqual(["actions", "chat", "cluster", "command", "suggest"]);
    expect(SHARES.actions).toBe(120);
    expect(SHARES.suggest).toBe(40);
    expect(SHARES.command).toBe(20);
    expect(Object.values(SHARES).reduce((a, b) => a + b, 0) + SPILL_OVER).toBe(DEFAULT_DAILY_CAP);
  });
});

describe("Gemini: a per-call deadline (deadlineMs)", () => {
  const hangs = () =>
    vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;

  it("ends a call that never answers at its own deadline, well before the default one", async () => {
    const started = Date.now();
    await expect(
      generateJson({ purpose: "actions", prompt: "p", schema: SCHEMA, fetchImpl: hangs(), sleep: async () => undefined, deadlineMs: 50 }),
    ).rejects.toBeInstanceOf(ModelError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
