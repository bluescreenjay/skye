// The life of one reply (specs/008-workspace-ai-chat/research.md sections 2 to 5). The order matters:
//   1. find the workspace;
//   2. make sure a model is configured, BEFORE anything is saved;
//   3. save the user's message;
//   4. build the context and start the model, and wait for its FIRST piece;
//   5. only when the whole answer has arrived, save the assistant message, once.
// A failure at step 4 or later leaves the user's message saved and no assistant message at all,
// so nothing half-written can ever look like a complete reply. Nothing here logs message text.
import type { ChatContextInfo, ChatReply, Message } from "@ai-browser/shared";
import { ModelError } from "../llm/errors";
import { buildContext } from "./context";
import { invalidMessage, MAX_MESSAGE_CHARS, messageTooLong, nothingToRetry, replyInProgress, withSavedMessage, WorkspaceNotFoundError } from "./errors";
import { tryLock } from "./lock";
import { findWorkspace, insertMessage, newestMessage } from "./messages";
import { getChatModel } from "./model";

export interface ReplyOptions {
  /** What the client sent as `message`, unchecked. */
  message?: unknown;
  /** What the client sent as `retry`, unchecked. */
  retry?: unknown;
  /** Aborting stops the model request and frees its slot. */
  signal?: AbortSignal;
}

/** A reply that has started: the user's message is saved and the model has produced its first piece. */
export interface ReplyHandle {
  userMessage: Message;
  info: ChatContextInfo;
  /** The first piece the model produced. */
  first: string;
  /** The remaining pieces. */
  rest: AsyncGenerator<string, void, void>;
  /** True once the reply was abandoned or the caller's signal aborted: it must not be saved as if it were complete. */
  readonly stopped: boolean;
  /** Saves the assistant message (once) and returns it, then gives the workspace back. Refuses when `stopped`. */
  complete(text: string): Promise<Message>;
  /** Stops the model, saves nothing, and gives the workspace back. Safe to call more than once. */
  abandon(): void;
}

/** Exactly one of a non-blank message (up to 4,000 characters once trimmed) or `retry: true`. Nothing is written before this passes. */
function resolveInput(options: ReplyOptions): { retry: true } | { retry: false; text: string } {
  const hasMessage = options.message !== undefined;
  if (options.retry !== undefined && typeof options.retry !== "boolean") throw invalidMessage();
  const retry = options.retry === true;
  if (hasMessage === retry) throw invalidMessage(); // both, or neither
  if (retry) return { retry: true };
  if (typeof options.message !== "string") throw invalidMessage();
  const text = options.message.trim();
  if (text === "") throw invalidMessage();
  if (text.length > MAX_MESSAGE_CHARS) throw messageTooLong();
  return { retry: false, text };
}

export async function beginReply(userId: string, workspaceId: string, options: ReplyOptions): Promise<ReplyHandle> {
  const workspace = await findWorkspace(userId, workspaceId);
  if (!workspace) throw new WorkspaceNotFoundError();

  const input = resolveInput(options);
  const model = getChatModel(); // throws when no key is set, before anything is written

  // One reply at a time: held until the reply is saved or abandoned, on every path out of here.
  const release = tryLock(userId, workspace.id);
  if (!release) throw replyInProgress();

  let userMessage: Message | undefined;
  try {
    if (input.retry) {
      // Answer the newest message again, without saving a second copy of it.
      const newest = await newestMessage(userId, workspace.id);
      if (!newest || newest.role !== "user") throw nothingToRetry();
      userMessage = newest;
    } else {
      userMessage = await insertMessage(userId, workspace.id, "user", input.text);
    }
    return await startReply(userId, workspace, userMessage, model, options.signal, release);
  } catch (error) {
    release();
    // the person's message stays saved; the route returns it
    throw userMessage ? withSavedMessage(error, userMessage) : error;
  }
}

async function startReply(
  userId: string,
  workspace: { id: string; name: string },
  userMessage: Message,
  model: ReturnType<typeof getChatModel>,
  callerSignal: AbortSignal | undefined,
  release: () => void,
): Promise<ReplyHandle> {
  const context = await buildContext(userId, workspace);

  const controller = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
  const iterator = model.stream({ system: context.system, messages: context.messages }, signal)[Symbol.asyncIterator]();
  let abandoned = false;
  const stop = () => {
    abandoned = true;
    controller.abort();
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
    release();
  };

  let firstResult: IteratorResult<string>;
  try {
    firstResult = await iterator.next();
  } catch (error) {
    stop();
    throw error;
  }
  if (firstResult.done) {
    stop();
    throw new ModelError("The AI service returned an empty answer.");
  }

  async function* rest(): AsyncGenerator<string, void, void> {
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      controller.abort(); // frees the slot whether the stream ended, broke, or the consumer left
    }
  }

  let saved: Promise<Message> | undefined;
  return {
    userMessage,
    info: context.info,
    first: firstResult.value,
    rest: rest(),
    get stopped() {
      return abandoned || callerSignal?.aborted === true;
    },
    complete(text) {
      if (abandoned || callerSignal?.aborted) return Promise.reject(new ModelError("The reply was stopped before it finished."));
      saved ??= insertMessage(userId, workspace.id, "assistant", text).finally(release);
      return saved;
    },
    abandon: stop,
  };
}

/** Drains the reply into one string, saves it, and returns the whole exchange (JSON mode). */
export async function collectReply(handle: ReplyHandle): Promise<ChatReply> {
  try {
    let text = handle.first;
    for await (const piece of handle.rest) text += piece;
    const assistantMessage = await handle.complete(text);
    return { userMessage: handle.userMessage, assistantMessage, contextInfo: handle.info };
  } catch (error) {
    handle.abandon();
    throw withSavedMessage(error, handle.userMessage);
  }
}
