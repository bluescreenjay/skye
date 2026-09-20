// The command-specific layer over the shared AI client (specs/011-global-command-bar/contracts/model.md).
// It gives the rest of the feature one small interface, so tests drop in a fake that answers with
// scripted JSON and no test ever calls a real provider. It can only return an answer: it has no tools.
import { generateJson, providerConfigured, unconfiguredMessage } from "../llm";
import { ModelUnconfiguredError } from "../llm/errors";
import { MODEL_DEADLINE_MS, MODEL_MAX_TOKENS } from "./limits";

export interface CommandModelInput {
  /** The fixed rules, then one JSON data block. */
  prompt: string;
  /** The strict JSON Schema of the answer. */
  schema: unknown;
}

export interface CommandModel {
  /** The model's raw JSON answer. Aborting `signal` stops the request. */
  interpret(input: CommandModelInput, signal?: AbortSignal): Promise<unknown>;
}

const providerCommandModel: CommandModel = {
  interpret: (input, signal) =>
    generateJson({
      purpose: "command",
      prompt: input.prompt,
      schema: input.schema,
      maxTokens: MODEL_MAX_TOKENS,
      deadlineMs: MODEL_DEADLINE_MS,
      signal,
    }),
};

let override: CommandModel | null = null;

/** Tests only: replace the model (null restores the real one). */
export function setCommandModelForTests(model: CommandModel | null): void {
  override = model;
}

/**
 * The model to use. Throws ModelUnconfiguredError when there is no key, so a caller that asks first
 * can fail before reading or sending anything.
 */
export function getCommandModel(): CommandModel {
  if (override) return override;
  if (!providerConfigured()) throw new ModelUnconfiguredError(unconfiguredMessage());
  return providerCommandModel;
}
