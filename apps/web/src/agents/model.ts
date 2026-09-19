// The agent-specific layer over the shared AI client (specs/010-workspace-agents/contracts/model.md).
// It gives the rest of the feature one small interface, so tests drop in a fake that answers with
// scripted JSON and no test ever calls a real provider. It can only return an answer: it has no tools.
import { generateJson, providerConfigured, unconfiguredMessage } from "../llm";
import { ModelUnconfiguredError } from "../llm/errors";
import type { AgentId } from "@ai-browser/shared";
import { MODEL_DEADLINE_MS, MODEL_MAX_TOKENS } from "./limits";

export interface AgentModelInput {
  agentId: AgentId;
  /** The fixed rules, then one JSON data block. */
  prompt: string;
  /** The strict JSON Schema of this agent's answer. */
  schema: unknown;
}

export interface AgentModel {
  /** The model's raw JSON answer. Aborting `signal` stops the request. */
  answer(input: AgentModelInput, signal?: AbortSignal): Promise<unknown>;
}

const providerAgentModel: AgentModel = {
  answer: (input, signal) =>
    generateJson({
      purpose: "actions",
      prompt: input.prompt,
      schema: input.schema,
      maxTokens: MODEL_MAX_TOKENS,
      deadlineMs: MODEL_DEADLINE_MS,
      signal,
    }),
};

let override: AgentModel | null = null;

/** Tests only: replace the model (null restores the real one). */
export function setAgentModelForTests(model: AgentModel | null): void {
  override = model;
}

/**
 * The model to use. Throws ModelUnconfiguredError when there is no key, so a caller that asks
 * first can fail before storing anything.
 */
export function getAgentModel(): AgentModel {
  if (override) return override;
  if (!providerConfigured()) throw new ModelUnconfiguredError(unconfiguredMessage());
  return providerAgentModel;
}
