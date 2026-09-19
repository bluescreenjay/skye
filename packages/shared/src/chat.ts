// Response shapes for workspace chat (feature 008). The web app builds these; the sidebar
// (feature 006) imports them from `@ai-browser/shared` and must not redeclare them.
// Contract: specs/008-workspace-ai-chat/contracts/shared-chat-types.md
// `Message` and `MessageRole` are unchanged and live in domain.ts.
// IDs are UUID strings; times are UTC ISO-8601 strings.
import type { Message } from "./domain";

/** What the model was given for one message (FR-004: the caller is told what the answer is based on). */
export interface ChatContextInfo {
  tabsIncluded: number;
  tabsTotal: number;
  planItemsIncluded: number;
  messagesIncluded: number;
}

/** A completed exchange, as returned when `stream` is false and as the final state of a stream. */
export interface ChatReply {
  userMessage: Message;
  assistantMessage: Message;
  /** What the answer is based on (counts). Not the text given to the model. */
  contextInfo: ChatContextInfo;
}

/** One page of a workspace's conversation, oldest first. */
export interface ChatHistoryPage {
  messages: Message[];
  /** True when older messages exist before the first one in `messages`. */
  hasMore: boolean;
  /** True while a reply is being written for this workspace right now. */
  replying: boolean;
  /** Set when the newest message is a user message with no reply (show a Retry). */
  unansweredMessageId: string | null;
}

export type ChatErrorCode =
  | "invalid_message"
  | "message_too_long"
  | "not_a_workspace"
  | "reply_in_progress"
  | "nothing_to_retry"
  | "invalid_cursor"
  | "budget_exhausted"
  | "model_error"
  | "model_unconfigured"
  | "interrupted";

/** The events of a streamed reply, in order. `meta` first, then `delta`s, then exactly one of `done` or `error`. */
export type ChatStreamEvent =
  | { event: "meta"; data: { userMessage: Message; contextInfo: ChatContextInfo } }
  | { event: "delta"; data: { text: string } }
  | { event: "done"; data: { assistantMessage: Message } }
  | { event: "error"; data: { code: ChatErrorCode; message: string } };
