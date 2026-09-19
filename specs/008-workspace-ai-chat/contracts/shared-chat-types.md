# Contract: Shared chat types

New file `packages/shared/src/chat.ts`, re-exported from `packages/shared/src/index.ts`. The web app and every client (the sidebar in feature 006) import these; nobody redeclares them (constitution principle V). `Message` and `MessageRole` already exist in `domain.ts` and are **not changed**. IDs are UUID strings; times are UTC ISO-8601 strings.

```ts
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
  context: ChatContextInfo;
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

/** The events of a streamed reply, in order. `meta` first, then `delta`s, then exactly one of `done` or `error`. */
export type ChatStreamEvent =
  | { event: "meta"; data: { userMessage: Message; context: ChatContextInfo } }
  | { event: "delta"; data: { text: string } }
  | { event: "done"; data: { assistantMessage: Message } }
  | { event: "error"; data: { code: ChatErrorCode; message: string } };

export type ChatErrorCode =
  | "invalid_message"
  | "message_too_long"
  | "not_a_workspace"
  | "reply_in_progress"
  | "nothing_to_retry"
  | "budget_exhausted"
  | "model_error"
  | "model_unconfigured"
  | "interrupted";
```

## Sync rule

`apps/web/src/chat/*` maps rows to `Message` with the existing mapper and builds these shapes; adding a field to any of them means updating this file, `contracts/http.md`, and the tests together.
