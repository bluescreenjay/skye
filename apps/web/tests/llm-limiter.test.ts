import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BudgetExceededError } from "@/src/llm/errors";
import { acquire, baseModel, capacityFor, limiterState, resetLimiterForTests } from "@/src/llm/limiter";

beforeEach(() => {
  delete process.env.LLM_CONCURRENCY;
  resetLimiterForTests();
});
afterEach(() => {
  delete process.env.LLM_CONCURRENCY;
  resetLimiterForTests();
});

describe("model families and capacity", () => {
  it("strips the effort and tool-calling suffixes so variants share one pool", () => {
    expect(baseModel("gpt-oss-120b-thinking-low")).toBe("gpt-oss-120b");
    expect(baseModel("gpt-oss-120b-thinking-high-legacy-tool-calling")).toBe("gpt-oss-120b");
    expect(baseModel("Kimi-K3-thinking-max-legacy-tool-calling")).toBe("Kimi-K3");
    expect(baseModel("DeepSeek-V4.1-Flash-thinking-max")).toBe("DeepSeek-V4.1-Flash");
    expect(baseModel("gpt-oss-120b")).toBe("gpt-oss-120b");
  });

  it("keeps headroom under the documented limits: two spare on big pools, one on small ones", () => {
    expect(capacityFor("gpt-oss-120b")).toBe(8);
    expect(capacityFor("gpt-oss-120b-thinking-low")).toBe(8);
    expect(capacityFor("DeepSeek-V4.1-Flash-thinking-low")).toBe(8);
    expect(capacityFor("GLM-5.3-thinking-high")).toBe(3);
    expect(capacityFor("Kimi-K3-thinking-low")).toBe(2);
    expect(capacityFor("some-unknown-model")).toBe(4);
  });

  it("LLM_CONCURRENCY overrides every model, and a bad value is ignored", () => {
    process.env.LLM_CONCURRENCY = "3";
    expect(capacityFor("gpt-oss-120b")).toBe(3);
    process.env.LLM_CONCURRENCY = "0";
    expect(capacityFor("gpt-oss-120b")).toBe(8);
    process.env.LLM_CONCURRENCY = "many";
    expect(capacityFor("gpt-oss-120b")).toBe(8);
  });
});

describe("acquire / release", () => {
  it("hands out slots up to capacity immediately, then makes the next caller wait", async () => {
    process.env.LLM_CONCURRENCY = "2";
    const a = await acquire("gpt-oss-120b");
    const b = await acquire("gpt-oss-120b-thinking-low"); // same family, same pool
    let third = false;
    const pending = acquire("gpt-oss-120b").then((release) => {
      third = true;
      return release;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(third).toBe(false);
    expect(limiterState()["gpt-oss-120b"]).toEqual({ active: 2, waiting: 1 });

    a(); // frees a slot: the waiter gets it
    const release3 = await pending;
    expect(third).toBe(true);
    expect(limiterState()["gpt-oss-120b"]).toEqual({ active: 2, waiting: 0 });
    b();
    release3();
    expect(limiterState()["gpt-oss-120b"]).toEqual({ active: 0, waiting: 0 });
  });

  it("serves waiters in the order they arrived", async () => {
    process.env.LLM_CONCURRENCY = "1";
    const first = await acquire("m");
    const order: number[] = [];
    const waiters = [1, 2, 3].map((n) => acquire("m").then((release) => (order.push(n), release)));
    first();
    for (const w of waiters) (await w)();
    expect(order).toEqual([1, 2, 3]);
  });

  it("release is safe to call twice and never frees more than one slot", async () => {
    process.env.LLM_CONCURRENCY = "1";
    const release = await acquire("m");
    release();
    release();
    const next = await acquire("m");
    let blocked = true;
    const waiting = acquire("m").then((r) => ((blocked = false), r));
    await new Promise((r) => setTimeout(r, 10));
    expect(blocked).toBe(true); // capacity 1 is still fully held by `next`
    next();
    (await waiting)();
  });

  it("a waiter whose signal aborts is removed and rejected as busy; the slot is not leaked", async () => {
    process.env.LLM_CONCURRENCY = "1";
    const holder = await acquire("m");
    const controller = new AbortController();
    const waiting = acquire("m", controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(BudgetExceededError);
    expect(limiterState().m).toEqual({ active: 1, waiting: 0 });
    holder();
    expect(limiterState().m).toEqual({ active: 0, waiting: 0 });
  });

  it("an already-aborted signal fails at once without joining the queue", async () => {
    process.env.LLM_CONCURRENCY = "1";
    const holder = await acquire("m");
    await expect(acquire("m", AbortSignal.abort())).rejects.toBeInstanceOf(BudgetExceededError);
    expect(limiterState().m.waiting).toBe(0);
    holder();
  });

  it("different model families do not share slots", async () => {
    process.env.LLM_CONCURRENCY = "1";
    const a = await acquire("gpt-oss-120b");
    const b = await acquire("Kimi-K3"); // would block if the pools were shared
    expect(limiterState()).toEqual({ "gpt-oss-120b": { active: 1, waiting: 0 }, "Kimi-K3": { active: 1, waiting: 0 } });
    a();
    b();
  });
});
