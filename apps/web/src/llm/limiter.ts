// A local concurrency limiter. The VT ARC API allows a fixed number of simultaneous
// requests per model and REJECTS the rest (HTTP 400 "concurrent session limit reached"),
// it does not queue them. Measured on 2026-09-19: 12 at once to gpt-oss-120b gave 10
// successes and 2 rejections, and the `-thinking-low` variant shares the base model's
// 10 slots. So we queue locally, per model family, and keep a little headroom.
import { BudgetExceededError } from "./errors";

/** Documented concurrent-request limits by base model (docs.arc.vt.edu, confirmed for gpt-oss-120b). */
const DOCUMENTED: Record<string, number> = {
  "gpt-oss-120b": 10,
  "DeepSeek-V4.1-Flash": 10,
  "GLM-5.3": 4,
  "Kimi-K3": 3,
};
const UNKNOWN_MODEL_CAPACITY = 4;

/** `gpt-oss-120b-thinking-low` and `gpt-oss-120b-legacy-tool-calling` share `gpt-oss-120b`'s slots. */
export function baseModel(model: string): string {
  return model.replace(/-legacy-tool-calling$/, "").replace(/-thinking-(low|medium|high|max)$/, "");
}

/**
 * How many requests we allow at once for this model: the documented limit minus headroom
 * (two spare slots on the large pools, one on the small), or LLM_CONCURRENCY if set.
 */
export function capacityFor(model: string): number {
  const override = Number(process.env.LLM_CONCURRENCY);
  if (Number.isInteger(override) && override >= 1) return override;
  const documented = DOCUMENTED[baseModel(model)];
  if (documented === undefined) return UNKNOWN_MODEL_CAPACITY;
  return Math.max(1, documented - (documented > 4 ? 2 : 1));
}

type Pool = { active: number; waiters: (() => void)[] };
const KEY = "__aiBrowserLlmLimiter";
type Holder = typeof globalThis & { [KEY]?: Map<string, Pool> };

function pools(): Map<string, Pool> {
  const holder = globalThis as Holder;
  return (holder[KEY] ??= new Map());
}

/**
 * Waits for a free slot for this model's family and returns the function that gives it
 * back (safe to call more than once). Rejects with a "busy" error if the signal aborts
 * while waiting, so a call never waits past its deadline.
 */
export async function acquire(model: string, signal?: AbortSignal): Promise<() => void> {
  const family = baseModel(model);
  const map = pools();
  const pool = map.get(family) ?? { active: 0, waiters: [] };
  map.set(family, pool);

  const releaseOnce = () => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = pool.waiters.shift();
      if (next) next(); // hand the slot straight to the next waiter: `active` stays the same
      else pool.active -= 1;
    };
  };

  if (pool.active < capacityFor(model)) {
    pool.active += 1;
    return releaseOnce();
  }

  return new Promise<() => void>((resolve, reject) => {
    const waiter = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve(releaseOnce());
    };
    const onAbort = () => {
      const at = pool.waiters.indexOf(waiter);
      if (at >= 0) pool.waiters.splice(at, 1);
      reject(new BudgetExceededError("The AI service is busy right now. Try again in a moment."));
    };
    if (signal?.aborted) return onAbort();
    pool.waiters.push(waiter);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Tests only. */
export function resetLimiterForTests(): void {
  delete (globalThis as Holder)[KEY];
}

/** Diagnostics: requests holding a slot and requests waiting, per model family. */
export function limiterState(): Record<string, { active: number; waiting: number }> {
  return Object.fromEntries([...pools()].map(([k, p]) => [k, { active: p.active, waiting: p.waiters.length }]));
}
