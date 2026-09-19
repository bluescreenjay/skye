// The default provider: the Virginia Tech ARC LLM API, an OpenAI-compatible service
// (https://docs.arc.vt.edu/ai/011_llm_api_arc_vt_edu.html). Any OpenAI-compatible
// endpoint works by setting LLM_BASE_URL and VT_LLM_API_KEY. What was measured on
// 2026-09-19 and is encoded here:
//  - it is reachable only on the VT VPN: off it every call is HTTP 403 with a VPN message;
//  - a request over the per-model concurrency limit is REJECTED (not queued) with HTTP 400
//    {"detail":"concurrent session limit reached"}: a transient condition, so we retry;
//    a local limiter (limiter.ts) keeps us under the limit in the first place;
//  - without `response_format` the model wraps its JSON in a code fence; with
//    `json_schema` (strict) or `json_object` it returns clean JSON;
//  - effort is part of the model id (`gpt-oss-120b-thinking-low`); reasoning arrives in a
//    separate field that we ignore.
// Messages returned to callers are fixed and generic: never the prompt, tab text, or the
// server's response body. Nothing here logs.
import { spend, type Purpose } from "./budget";
import { BudgetExceededError, ModelError, ModelUnconfiguredError } from "./errors";
import { acquire } from "./limiter";
import { runStream, type Decision } from "./stream-core";
import { DEADLINE_MS, DEFAULT_CHAT_MAX_TOKENS, isAbort, wait, type GenerateJsonOptions, type StreamTextOptions } from "./types";

export const DEFAULT_BASE_URL = "https://llm-api.arc.vt.edu/api/v1";
const DEFAULT_MAX_TOKENS = 4_000; // the service caps a non-streaming request at 8,000
const MAX_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

/** Which model serves each purpose. Effort lives in the id: low for fast structured work. */
export const DEFAULT_MODELS: Record<Purpose, string> = {
  cluster: "gpt-oss-120b-thinking-low",
  command: "gpt-oss-120b-thinking-low",
  // Low effort for chat too: measured first words 0.3 s, against 0.5 to 4.2 s (varying with load) for medium.
  chat: "gpt-oss-120b-thinking-low",
  actions: "gpt-oss-120b",
};

/** LLM_MODEL_<PURPOSE>, else LLM_MODEL, else this purpose's default. */
export function vtModelFor(purpose: Purpose): string {
  return process.env[`LLM_MODEL_${purpose.toUpperCase()}`]?.trim() || process.env.LLM_MODEL?.trim() || DEFAULT_MODELS[purpose];
}

export function vtApiKey(): string | undefined {
  return process.env.VT_LLM_API_KEY?.trim() || process.env.LLM_API_KEY?.trim() || undefined;
}

export function vtBaseUrl(): string {
  return (process.env.LLM_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** A request over the concurrency limit: HTTP 400 with this detail (not a 429). */
const CONCURRENCY = /concurrent session limit|too many concurrent|concurrency limit/i;
const VPN = /\bVPN\b/i;
const SCHEMA_REJECTED = /response_format|json_schema|schema|strict/i;

/** Seconds to wait before retrying, if the server said (`error.retry_after_s`), else undefined. */
function retryAfterMs(text: string): number | undefined {
  try {
    const seconds = Number(JSON.parse(text)?.error?.retry_after_s);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_BACKOFF_MS) : undefined;
  } catch {
    return undefined;
  }
}

/** What a non-200 answer from the VT API means. Shared by the JSON call and by streaming. */
type VtFailure =
  | { kind: "busy"; delayMs?: number }
  | { kind: "unavailable" }
  | { kind: "schema_rejected" }
  | { kind: "fatal"; error: Error };

export function classifyVtFailure(status: number, text: string, model: string): VtFailure {
  // At capacity: a 400 with the concurrency detail (not a 429), or a real 429. Transient.
  if ((status === 400 && CONCURRENCY.test(text)) || status === 429) return { kind: "busy", delayMs: retryAfterMs(text) };
  // The service or a gateway hiccuped.
  if ([502, 503, 504].includes(status)) return { kind: "unavailable" };
  // The strict schema was refused.
  if ((status === 400 || status === 422) && SCHEMA_REJECTED.test(text)) return { kind: "schema_rejected" };
  // Not transient.
  if (status === 403 && VPN.test(text)) {
    return { kind: "fatal", error: new ModelError("The AI service is only reachable on the VT VPN. Connect to it, or set LLM_PROVIDER=gemini.") };
  }
  if (status === 401 || status === 403) return { kind: "fatal", error: new ModelError("The AI service rejected the API key.") };
  if (status === 404) {
    return { kind: "fatal", error: new ModelError(`The AI model "${model}" is not available. Set LLM_MODEL to a model your key can call.`) };
  }
  return { kind: "fatal", error: new ModelError() };
}

/** The answer text with a wrapping code fence removed, or null when there is none. */
function answerText(data: unknown): { text: string; truncated: boolean } | null {
  const choice = (data as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] } | null)?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || content.trim() === "") return null;
  const text = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return { text, truncated: choice?.finish_reason === "length" };
}

/** Sends one prompt (retrying only what is transient) and returns the parsed JSON answer. */
export async function vtGenerateJson(options: GenerateJsonOptions): Promise<unknown> {
  const apiKey = vtApiKey();
  if (!apiKey) throw new ModelUnconfiguredError();

  const model = vtModelFor(options.purpose);
  const url = `${vtBaseUrl()}/chat/completions`;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? wait;
  const deadline = AbortSignal.timeout(options.deadlineMs ?? DEADLINE_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

  let mode: "json_schema" | "json_object" = "json_schema";
  const body = () =>
    JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: "user", content: options.prompt }],
      response_format:
        mode === "json_schema"
          ? { type: "json_schema", json_schema: { name: "answer", schema: options.schema, strict: true } }
          : { type: "json_object" },
    });

  let lastBusy = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    spend(options.purpose); // counts every attempt, including retries

    let release: () => void;
    try {
      release = await acquire(model, signal); // wait for a free slot, but never past the deadline
    } catch (error) {
      if (error instanceof BudgetExceededError) throw error;
      throw new ModelError("The AI service did not respond in time.");
    }

    let status: number;
    let text: string;
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: body(),
        signal,
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      if (isAbort(error)) throw new ModelError("The AI service did not respond in time.");
      throw new ModelError();
    } finally {
      release();
    }

    if (status === 200) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ModelError("The AI service returned an answer that could not be read.");
      }
      const answer = answerText(parsed);
      if (answer === null) throw new ModelError("The AI service returned an empty answer.");
      if (answer.truncated) throw new ModelError("The AI service's answer was cut off.");
      try {
        return JSON.parse(answer.text);
      } catch {
        throw new ModelError("The AI service returned an answer that could not be read.");
      }
    }

    const failure = classifyVtFailure(status, text, model);

    if (failure.kind === "busy") {
      lastBusy = true;
      const delay = failure.delayMs ?? Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
      try {
        await sleep(delay, signal);
      } catch {
        break; // the deadline arrived while waiting
      }
      continue;
    }

    if (failure.kind === "unavailable") {
      lastBusy = false;
      if (attempt === 0) {
        try {
          await sleep(1_000, signal);
        } catch {
          break;
        }
        continue;
      }
      throw new ModelError("The AI service is temporarily unavailable.");
    }

    // The strict schema was refused: fall back to plain JSON mode once.
    if (failure.kind === "schema_rejected" && mode === "json_schema") {
      mode = "json_object";
      continue;
    }

    throw failure.kind === "fatal" ? failure.error : new ModelError();
  }

  // Ran out of attempts or time while the service kept saying it was busy.
  if (lastBusy) throw new BudgetExceededError("The AI service is busy right now. Try again in a moment.");
  throw new ModelError("The AI service did not respond in time.");
}

/**
 * Streams an answer as it is written (feature 008). The request, retry, slot, deadline, and stop
 * rules are in stream-core.ts; this file only says how to talk to the VT API: the system message
 * first, `stream: true`, text in `choices[0].delta.content`, reasoning ignored, `[DONE]` at the end.
 */
export async function* vtStreamText(options: StreamTextOptions): AsyncGenerator<string, void, void> {
  const apiKey = vtApiKey();
  if (!apiKey) throw new ModelUnconfiguredError();

  const model = vtModelFor(options.purpose);
  const url = `${vtBaseUrl()}/chat/completions`;
  const doFetch = options.fetchImpl ?? fetch;
  const body = JSON.stringify({
    model,
    stream: true,
    temperature: 0.3,
    max_tokens: options.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS,
    messages: [{ role: "system", content: options.system }, ...options.messages],
  });

  yield* runStream({
    purpose: options.purpose,
    model,
    signal: options.signal,
    sleep: options.sleep,
    send: (signal) =>
      doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body,
        signal,
      }),
    classify(status, text): Decision {
      const failure = classifyVtFailure(status, text, model);
      if (failure.kind === "busy") return { kind: "busy", delayMs: failure.delayMs };
      if (failure.kind === "unavailable") return { kind: "retry_once" };
      // A stream sends no response_format, so a "schema" complaint is just a bad request.
      return { kind: "fatal", error: failure.kind === "fatal" ? failure.error : new ModelError() };
    },
    extract(payload) {
      if (payload.trim() === "[DONE]") return { done: true };
      let data: { choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[] };
      try {
        data = JSON.parse(payload);
      } catch {
        throw new ModelError("The AI service's answer was interrupted.");
      }
      const choice = data?.choices?.[0];
      const content = choice?.delta?.content; // reasoning_content / reasoning are ignored on purpose
      return { text: typeof content === "string" ? content : undefined, done: typeof choice?.finish_reason === "string" };
    },
  });
}
