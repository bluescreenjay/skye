// The Home side of workspace chat (feature 008's HTTP contract:
// specs/008-workspace-ai-chat/contracts/http.md). Pure logic, no React: an event-stream
// parser, a client that sends one message and reports what happened, and the small
// helpers the chat panel uses. Reply text is only ever handed back as plain strings; the
// panel renders it as text, never as HTML, links, or images (contract rule 1).
import type { ChatContextInfo, ChatErrorCode, ChatHistoryPage, Message } from "@ai-browser/shared";
import type { Config } from "../config";

export interface SseEvent {
  event: string;
  data: unknown;
}

/**
 * Incremental parser for `event: <name>` / `data: <json>` blocks separated by a blank line.
 * Network chunks can split a block anywhere, including inside a multi-byte character, so
 * feed it the bytes through one TextDecoder in stream mode (see `readEvents`).
 */
export function createSseParser() {
  let buffer = "";
  return {
    push(text: string): SseEvent[] {
      buffer += text.replace(/\r\n/g, "\n");
      const events: SseEvent[] = [];
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let name = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue; // comment
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length === 0) continue;
        try {
          events.push({ event: name, data: JSON.parse(data.join("\n")) });
        } catch {
          // a block that is not JSON is not one of ours: skip it
        }
      }
      return events;
    },
  };
}

async function* readEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  // Stopping must never leave a read waiting: cancelling the reader ends it.
  const stop = () => void reader.cancel().catch(() => undefined);
  if (signal?.aborted) stop();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) yield event;
    }
    for (const event of parser.push(decoder.decode())) yield event;
  } finally {
    signal?.removeEventListener("abort", stop);
    reader.cancel().catch(() => undefined);
  }
}

export type ChatOutcome =
  /** The whole reply arrived and was saved. */
  | { kind: "done"; userMessage: Message; assistantMessage: Message; contextInfo: ChatContextInfo }
  /** The reply broke off after it had started. The person's message is saved, no reply is: offer retry. */
  | { kind: "interrupted"; userMessage: Message | null }
  /** Refused or failed before any text. `userMessage` is set when the message was saved (offer retry). */
  | { kind: "failed"; status: number; code: ChatErrorCode | null; message: string; userMessage: Message | null }
  /** The caller stopped it (the panel closed). Nothing more to show. */
  | { kind: "aborted" };

export interface SendHandlers {
  /** The saved user message and what the answer is based on, before the first words. */
  onMeta?: (meta: { userMessage: Message; contextInfo: ChatContextInfo }) => void;
  /** Each piece of the reply as it is written. */
  onDelta?: (text: string) => void;
}

export interface ChatRequestOptions {
  signal?: AbortSignal;
  /** Tests only. */
  fetchImpl?: typeof fetch;
}

const authHeaders = (config: Config): Record<string, string> => ({
  Authorization: `Bearer ${config.deviceToken}`,
  "Content-Type": "application/json",
});

const chatUrl = (config: Config, workspaceId: string) =>
  `${config.apiBaseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/chat`;

/** A short sentence for a status the server answered without one of its own. */
export function statusMessage(status: number): string {
  if (status === 0) return "could not reach the server";
  if (status === 401) return "pairing failed — check your device token";
  if (status === 404) return "this workspace is not on the server yet";
  return "the assistant could not answer — try again";
}

const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
const isMessage = (value: unknown): value is Message => typeof asObject(value).id === "string" && typeof asObject(value).content === "string";

/**
 * Sends one message (or `{ retry: true }` for the newest unanswered one) and streams the reply.
 * Never throws: every way it can end is a `ChatOutcome`.
 */
export async function sendChat(
  config: Config,
  workspaceId: string,
  input: { message: string } | { retry: true },
  handlers: SendHandlers = {},
  options: ChatRequestOptions = {},
): Promise<ChatOutcome> {
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(chatUrl(config, workspaceId), {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify(input), // streaming is the default
      signal: options.signal,
    });
  } catch {
    if (options.signal?.aborted) return { kind: "aborted" };
    return { kind: "failed", status: 0, code: null, message: statusMessage(0), userMessage: null };
  }

  const isStream = response.headers.get("content-type")?.includes("text/event-stream") === true;
  if (!response.ok || !isStream || !response.body) {
    // Anything that fails before the first words is an ordinary JSON error.
    let body: Record<string, unknown> = {};
    try {
      body = asObject(await response.json());
    } catch {
      // not JSON
    }
    const message = typeof body.error === "string" && body.error.trim() ? body.error.trim() : statusMessage(response.status);
    return {
      kind: "failed",
      status: response.status,
      code: typeof body.code === "string" ? (body.code as ChatErrorCode) : null,
      message,
      userMessage: isMessage(body.userMessage) ? body.userMessage : null,
    };
  }

  let userMessage: Message | null = null;
  let contextInfo: ChatContextInfo | null = null;
  try {
    for await (const { event, data } of readEvents(response.body, options.signal)) {
      const payload = asObject(data);
      if (event === "meta" && isMessage(payload.userMessage)) {
        userMessage = payload.userMessage;
        contextInfo = payload.contextInfo as ChatContextInfo;
        handlers.onMeta?.({ userMessage, contextInfo });
      } else if (event === "delta" && typeof payload.text === "string") {
        handlers.onDelta?.(payload.text);
      } else if (event === "done" && isMessage(payload.assistantMessage) && userMessage && contextInfo) {
        return { kind: "done", userMessage, assistantMessage: payload.assistantMessage, contextInfo };
      } else if (event === "error") {
        return { kind: "interrupted", userMessage };
      }
    }
  } catch {
    if (options.signal?.aborted) return { kind: "aborted" };
  }
  if (options.signal?.aborted) return { kind: "aborted" };
  // The connection ended with neither `done` nor `error`: the same as an interrupted reply.
  return { kind: "interrupted", userMessage };
}

/** The saved conversation (newest page, oldest first), or null when it cannot be read. */
export async function readHistory(
  config: Config,
  workspaceId: string,
  options: ChatRequestOptions = {},
): Promise<ChatHistoryPage | null> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${chatUrl(config, workspaceId)}?limit=50`, {
      headers: authHeaders(config),
      signal: options.signal,
    });
    if (!response.ok) return null;
    const body = asObject(await response.json());
    if (!Array.isArray(body.messages)) return null;
    return {
      messages: body.messages.filter(isMessage),
      hasMore: body.hasMore === true,
      replying: body.replying === true,
      unansweredMessageId: typeof body.unansweredMessageId === "string" ? body.unansweredMessageId : null,
    };
  } catch {
    return null;
  }
}

/** One row of the chat log. */
export interface ChatLine {
  id: string;
  who: "you" | "skye";
  text: string;
}

/** Saved messages as log rows. Only what a person said or was answered: system rows never show. */
export function toLines(messages: Message[]): ChatLine[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ id: message.id, who: message.role === "user" ? "you" : "skye", text: message.content }));
}

/** "based on 9 of 9 tabs", or "based on 40 of 60 tabs" when the answer covers fewer than the workspace has. */
export function contextLabel(info: ChatContextInfo): string {
  const tabs = (n: number) => `${n} ${n === 1 ? "tab" : "tabs"}`;
  if (info.tabsTotal === 0) return "no tabs in this workspace yet";
  return `based on ${info.tabsIncluded} of ${tabs(info.tabsTotal)}`;
}
