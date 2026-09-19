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
  /** One total deadline for the call, including retries and any wait for a slot. Defaults to `DEADLINE_MS`. */
  deadlineMs?: number;
}

/** One total deadline for a call, including its retries and any wait for a free slot. */
export const DEADLINE_MS = 25_000;

/** How long a stream may run in total, from the request to the last piece (research section 2 of feature 008). */
export const STREAM_TOTAL_MS = 90_000;

/** Chat replies are asked to stay concise: at most this many generated tokens. */
export const DEFAULT_CHAT_MAX_TOKENS = 1_500;

/** One turn of a conversation given to the model. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface StreamTextOptions {
  purpose: Purpose;
  /** The rules and the workspace data, given to the model as its system message. */
  system: string;
  /** The conversation, oldest first; the last turn is the user's message. */
  messages: ChatTurn[];
  maxTokens?: number;
  /** Aborting stops the request and frees the concurrency slot. */
  signal?: AbortSignal;
  /** Tests only. */
  fetchImpl?: typeof fetch;
  /** Tests only: replaces every wait (retry backoff). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

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
