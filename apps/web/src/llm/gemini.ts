// The only file that knows about the AI vendor (Google Gemini, REST). A pivot to
// another provider replaces this file and nothing else (contracts/model.md).
//
// Behavior worth knowing (specs/004-ai-clustering/research.md sections 1, 16, 18):
//  - every request is counted against the daily budget BEFORE it is sent;
//  - one total 25 s deadline covers the call and its single retry;
//  - HTTP 429 is never retried: it means a quota is used up (a minute or a day),
//    so a retry cannot help and would only spend another request;
//  - HTTP 503 is retried once after about a second, if the deadline allows;
//  - error messages are fixed and generic: never the prompt, tab text, or the
//    vendor's response body. Nothing here logs.
import { spend, type Purpose } from "./budget";
import { BudgetExceededError, ModelError, ModelUnconfiguredError } from "./errors";

export const DEFAULT_MODEL = "gemini-3.5-flash-lite";
export const DEADLINE_MS = 25_000;
const RETRY_DELAY_MS = 1_000;
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GenerateJsonOptions {
  purpose: Purpose;
  /** The whole prompt: instructions followed by the data. */
  prompt: string;
  /** Response schema in the vendor's OpenAPI-style dialect (uppercase type names). */
  schema: unknown;
  signal?: AbortSignal;
  /** Tests only. */
  fetchImpl?: typeof fetch;
  /** Tests only: replaces the 1 s wait before the retry. */
  sleep?: (ms: number) => Promise<void>;
}

/** GEMINI_MODEL_<PURPOSE>, else GEMINI_MODEL, else the default. */
export function modelFor(purpose: Purpose): string {
  const specific = process.env[`GEMINI_MODEL_${purpose.toUpperCase()}`]?.trim();
  const general = process.env.GEMINI_MODEL?.trim();
  return specific || general || DEFAULT_MODEL;
}

/** GEMINI_THINKING_LEVEL (minimal | low | medium | high), default minimal: fastest. Raise it if grouping quality is short. */
export function thinkingLevel(): string {
  return process.env.GEMINI_THINKING_LEVEL?.trim() || "minimal";
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** Sends one request (with at most one retry) and returns the model's answer parsed as JSON. */
export async function generateJson(options: GenerateJsonOptions): Promise<unknown> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new ModelUnconfiguredError();

  const model = modelFor(options.purpose);
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? wait;
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: options.prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: options.schema,
      // thinkingLevel, not thinkingBudget: the lite model rejects thinkingBudget: 0 with HTTP 400.
      thinkingConfig: { thinkingLevel: thinkingLevel() },
    },
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    spend(options.purpose); // counts every attempt, including the retry

    let response: Response;
    try {
      response = await doFetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body,
        signal,
      });
    } catch (error) {
      if (isAbort(error)) throw new ModelError("The AI service did not respond in time.");
      throw new ModelError();
    }

    if (response.status === 429) throw new BudgetExceededError("The AI service's quota has been reached. Try again later.");

    if (response.status === 503) {
      if (attempt === 0 && !signal.aborted) {
        await sleep(RETRY_DELAY_MS);
        if (!signal.aborted) continue;
      }
      throw new ModelError("The AI service is temporarily unavailable.");
    }

    if (response.status === 404) {
      throw new ModelError(`The AI model "${model}" is not available. Set GEMINI_MODEL to a model your key can call.`);
    }
    if (!response.ok) throw new ModelError();

    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      if (isAbort(error)) throw new ModelError("The AI service did not respond in time.");
      throw new ModelError();
    }

    const text = answerText(data);
    if (text === null) throw new ModelError("The AI service returned an empty answer.");
    try {
      return JSON.parse(text);
    } catch {
      throw new ModelError("The AI service returned an answer that could not be read.");
    }
  }
  throw new ModelError(); // unreachable: the loop returns or throws
}

/** The answer text, skipping any "thought" parts. Null when there is none. */
function answerText(data: unknown): string | null {
  const parts = (data as { candidates?: { content?: { parts?: unknown } }[] } | null)?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .filter((p): p is { text: string; thought?: boolean } => typeof p?.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");
  return text.length > 0 ? text : null;
}
