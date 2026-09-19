// The chat-specific layer over the shared AI client (specs/008-workspace-ai-chat/contracts/model.md).
// It gives the rest of chat one small interface, so tests can drop in a fake that streams
// scripted text and no test ever calls a real provider.
import { providerConfigured, streamText, unconfiguredMessage, type ChatTurn } from "../llm";
import { ModelUnconfiguredError } from "../llm/errors";

export interface ChatModelInput {
  /** The rules and the workspace data. */
  system: string;
  /** The conversation, oldest first; the last turn is the user's message. */
  messages: ChatTurn[];
}

export interface ChatModel {
  /** The answer, piece by piece. Aborting `signal` stops the request and frees its slot. */
  stream(input: ChatModelInput, signal?: AbortSignal): AsyncIterable<string>;
}

const providerChatModel: ChatModel = {
  stream: (input, signal) => streamText({ purpose: "chat", system: input.system, messages: input.messages, signal }),
};

let override: ChatModel | null = null;

/** Tests only: replace the model (null restores the real one). */
export function setChatModelForTests(model: ChatModel | null): void {
  override = model;
}

/**
 * The model to use. Throws ModelUnconfiguredError when there is no key, so a caller
 * that asks first can fail before saving anything.
 */
export function getChatModel(): ChatModel {
  if (override) return override;
  if (!providerConfigured()) throw new ModelUnconfiguredError(unconfiguredMessage());
  return providerChatModel;
}
