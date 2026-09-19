// The errors chat can end with, and the fixed plain-language messages a person sees for them
// (specs/008-workspace-ai-chat/research.md section 11, contracts/http.md). A message never
// contains a prompt, tab content, message text, or a vendor's response body.
import type { ChatErrorCode, Message } from "@ai-browser/shared";
import { describeFailure } from "../llm/situation";

/** The longest message a person may send, in characters (after trimming). */
export const MAX_MESSAGE_CHARS = 4_000;

const SAVED = "Your message is saved.";

/** Shown as the `error` event's message when a reply breaks off after text had started. */
export const INTERRUPTED_MESSAGE = "The answer was interrupted. Your message is saved; retry to get a full answer.";

/** An error with an HTTP status and a code a client can act on; `message` is safe to show. */
export class ChatError extends Error {
  readonly status: number;
  readonly code: ChatErrorCode;
  /** Extra fields for the response body (for example `limit`). */
  readonly extra: Record<string, unknown>;

  constructor(status: number, code: ChatErrorCode, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ChatError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const invalidMessage = () =>
  new ChatError(400, "invalid_message", 'Send a JSON body with a non-empty "message" text, or { "retry": true } to answer your last message again.');

export const messageTooLong = () =>
  new ChatError(400, "message_too_long", `That message is too long. Keep it under ${MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters.`, {
    limit: MAX_MESSAGE_CHARS,
  });

export const notAWorkspace = () =>
  new ChatError(400, "not_a_workspace", "Chat is for a workspace. Move these tabs into a workspace to chat about them.");

export const replyInProgress = () =>
  new ChatError(409, "reply_in_progress", "A reply is already being written for this workspace. Wait for it to finish.");

export const nothingToRetry = () => new ChatError(409, "nothing_to_retry", "There is no unanswered message to retry.");

export const invalidCursor = () => new ChatError(400, "invalid_cursor", "That page marker is not a message in this workspace.");

/** What a failed model call looks like to the caller. */
export interface FriendlyError {
  status: number;
  code: ChatErrorCode;
  message: string;
}

/**
 * Maps the shared AI errors to a status, a code, and a message a person can read.
 * The messages come from the error's own fixed text only to tell situations apart
 * (busy, quota, daily allowance, VPN); what is shown is written here.
 */
export function friendlyLlmError(error: unknown): FriendlyError {
  switch (describeFailure(error)) {
    case "unconfigured":
      return { status: 503, code: "model_unconfigured", message: "The AI assistant isn't set up on this server yet." };
    case "busy":
      return { status: 429, code: "budget_exhausted", message: `The AI assistant is busy right now. ${SAVED} Try again in a moment.` };
    case "quota":
      return { status: 429, code: "budget_exhausted", message: `The AI service's quota has been reached. ${SAVED} Try again later.` };
    case "daily":
      return { status: 429, code: "budget_exhausted", message: `The daily AI limit has been reached. ${SAVED}` };
    case "vpn":
      // The provider's own message also carries an operator hint (an environment variable); a person only needs the VPN part.
      return { status: 502, code: "model_error", message: `The AI service is only reachable on the VT VPN. Connect to it and try again. ${SAVED}` };
    default:
      return { status: 502, code: "model_error", message: `The AI assistant couldn't answer right now. ${SAVED} Try again in a moment.` };
  }
}

/** The workspace does not exist for this user (or the id is not a workspace id at all). The route answers 404. */
export class WorkspaceNotFoundError extends Error {
  constructor() {
    super("Workspace not found");
    this.name = "WorkspaceNotFoundError";
  }
}

// When a reply fails after the person's message was saved, the error remembers that message so
// the route can hand it back (the client shows it and offers Retry). A WeakMap avoids changing
// the error object itself.
const savedWith = new WeakMap<object, Message>();

/** Notes that `message` was saved before `error` happened, and returns the same error. */
export function withSavedMessage<E>(error: E, message: Message): E {
  if (typeof error === "object" && error !== null) savedWith.set(error, message);
  return error;
}

/** The user message that was saved before this error happened, if any. */
export function savedMessageOf(error: unknown): Message | undefined {
  return typeof error === "object" && error !== null ? savedWith.get(error) : undefined;
}
