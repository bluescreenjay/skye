// The backup provider: Google Gemini over REST (select it with LLM_PROVIDER=gemini).
// Behavior worth knowing (specs/004-ai-clustering/research.md sections 1, 16, 18):
//  - every request is counted against the daily budget BEFORE it is sent;
//  - one total 25 s deadline covers the call and its single retry;
//  - HTTP 429 is never retried: on the free tier it means a quota is used up (15 requests a
//    minute or 500 a day), so a retry cannot help and would only spend another request;
//  - HTTP 503 is retried once after about a second, if the deadline allows;
//  - error messages are fixed and generic: never the prompt, tab text, or the vendor's
//    response body. Nothing here logs.
import { spend } from "./budget";
import { BudgetExceededError, ModelError, ModelUnconfiguredError } from "./errors";
import { runStream, type Decision } from "./stream-core";
import { DEADLINE_MS, DEFAULT_CHAT_MAX_TOKENS, isAbort, wait, type GenerateJsonOptions, type StreamTextOptions } from "./types";

export const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const RETRY_DELAY_MS = 1_000;
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/** GEMINI_MODEL_<PURPOSE>, else GEMINI_MODEL, else the default. */
export function geminiModelFor(purpose: GenerateJsonOptions["purpose"]): string {
  const specific = process.env[`GEMINI_MODEL_${purpose.toUpperCase()}`]?.trim();
  const general = process.env.GEMINI_MODEL?.trim();
  return specific || general || DEFAULT_MODEL;
}

export function geminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY?.trim() || undefined;
}

/** GEMINI_THINKING_LEVEL (minimal | low | medium | high), default minimal: fastest. */
export function thinkingLevel(): string {
  return process.env.GEMINI_THINKING_LEVEL?.trim() || "minimal";
}

/**
 * Standard JSON Schema -> Gemini's dialect: uppercase type names, `nullable: true` instead
 * of a `["string", "null"]` type, and no `additionalProperties`. A property that may be
 * null is also dropped from `required` (strict JSON Schema wants every property required,
 * Gemini does not). This matters: on 2026-09-19, marking a nullable `emoji` and
 * `existingWorkspaceId` as required made Gemini leave out a whole group in 3 of 3 runs,
 * while leaving them optional found it in 3 of 3.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  const source = schema as Record<string, unknown>;
  const isNullable = (definition: unknown) => {
    const type = (definition as { type?: unknown } | null)?.type;
    return Array.isArray(type) && type.includes("null");
  };
  const properties = source.properties as Record<string, unknown> | undefined;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "additionalProperties") continue;
    if (key === "type") {
      const types = (Array.isArray(value) ? value : [value]).filter((t) => t !== "null") as string[];
      if (Array.isArray(value) && value.includes("null")) out.nullable = true;
      out.type = String(types[0] ?? "string").toUpperCase();
    } else if (key === "properties" && properties) {
      out.properties = Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    } else if (key === "required" && Array.isArray(value) && properties) {
      out.required = value.filter((name) => !isNullable(properties[name as string]));
    } else {
      out[key] = key === "items" ? toGeminiSchema(value) : value;
    }
  }
  return out;
}

/** Sends one request (with at most one retry) and returns the model's answer parsed as JSON. */
export async function geminiGenerateJson(options: GenerateJsonOptions): Promise<unknown> {
  const apiKey = geminiApiKey();
  if (!apiKey) throw new ModelUnconfiguredError();

  const model = geminiModelFor(options.purpose);
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? wait;
  const deadline = AbortSignal.timeout(options.deadlineMs ?? DEADLINE_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: options.prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: toGeminiSchema(options.schema),
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
        try {
          await sleep(RETRY_DELAY_MS, signal);
          continue;
        } catch {
          throw new ModelError("The AI service did not respond in time.");
        }
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

/**
 * Streams an answer as it is written (feature 008): `streamGenerateContent?alt=sse`, the system
 * message as `systemInstruction`, the conversation as `contents` (the assistant's turns use the
 * role "model"), text in `candidates[0].content.parts[]` with any "thought" parts skipped.
 * On the free tier a 429 means a quota is used up, so it is never retried (see the top of this file).
 */
export async function* geminiStreamText(options: StreamTextOptions): AsyncGenerator<string, void, void> {
  const apiKey = geminiApiKey();
  if (!apiKey) throw new ModelUnconfiguredError();

  const model = geminiModelFor(options.purpose);
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${ENDPOINT}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: options.system }] },
    contents: options.messages.map((turn) => ({ role: turn.role === "assistant" ? "model" : "user", parts: [{ text: turn.content }] })),
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: options.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS,
      thinkingConfig: { thinkingLevel: thinkingLevel() },
    },
  });

  yield* runStream({
    purpose: options.purpose,
    model,
    signal: options.signal,
    sleep: options.sleep,
    send: (signal) =>
      doFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey }, body, signal }),
    classify(status): Decision {
      if (status === 429) return { kind: "fatal", error: new BudgetExceededError("The AI service's quota has been reached. Try again later.") };
      if (status === 503) return { kind: "retry_once" };
      if (status === 404) return { kind: "fatal", error: new ModelError(`The AI model "${model}" is not available. Set GEMINI_MODEL to a model your key can call.`) };
      return { kind: "fatal", error: new ModelError() };
    },
    extract(payload) {
      let data: { candidates?: { content?: { parts?: unknown }; finishReason?: unknown }[] };
      try {
        data = JSON.parse(payload);
      } catch {
        throw new ModelError("The AI service's answer was interrupted.");
      }
      const candidate = data?.candidates?.[0];
      const parts = candidate?.content?.parts;
      const text = Array.isArray(parts)
        ? parts
            .filter((part): part is { text: string; thought?: boolean } => typeof part?.text === "string" && !part.thought)
            .map((part) => part.text)
            .join("")
        : "";
      return { text: text || undefined, done: typeof candidate?.finishReason === "string" };
    },
  });
}
