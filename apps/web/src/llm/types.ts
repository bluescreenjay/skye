// Types shared by every AI provider in this folder. A provider turns one prompt and a
// JSON Schema into one parsed JSON answer, and nothing else in the app knows which
// provider (or model) did it (constitution: a vendor pivot must be a config change plus
// one module).
import type { Purpose } from "./budget";

export type Provider = "vt" | "gemini";

export interface GenerateJsonOptions {
  purpose: Purpose;
  /** The whole prompt: instructions followed by the data. */
  prompt: string;
  /**
   * Standard JSON Schema (lowercase types, nullable as `["string", "null"]`,
   * `additionalProperties: false`). Each provider translates it to what its API accepts.
   */
  schema: unknown;
  /** Upper bound on generated tokens. Providers cap it where they must. */
  maxTokens?: number;
  signal?: AbortSignal;
  /** Tests only. */
  fetchImpl?: typeof fetch;
  /** Tests only: replaces every wait (retry backoff). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** One total deadline for a call, including its retries and any wait for a free slot. */
export const DEADLINE_MS = 25_000;

/** Waits `ms`, rejecting early if the signal aborts. */
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
