// The action-specific layer over the shared AI client (specs/010b-mcp-action-tools/contracts/model.md).
// Tests drop in a scripted fake. The model can only return JSON: it has no tools and cannot execute.
import { generateJson, providerConfigured, unconfiguredMessage } from "../llm";
import { ModelUnconfiguredError } from "../llm/errors";
import { JOB_LIMIT_MS, STEP_MAX_TOKENS, SUGGEST_DEADLINE_MS, SUGGEST_MAX_TOKENS, TURN_DEADLINE_MS } from "./limits";

/** Mail content. Prompt builders do not accept this type, so it cannot be interpolated by accident. */
export type PrivateContent = { readonly __private: "mail"; readonly text: string };

export function privateMail(text: string): PrivateContent {
  return { __private: "mail", text };
}

export interface ActionModelInput {
  prompt: string;
  schema: unknown;
}

export interface ActionModel {
  suggest(input: ActionModelInput, signal?: AbortSignal): Promise<unknown>;
  step(input: ActionModelInput, signal?: AbortSignal): Promise<unknown>;
}

const providerActionModel: ActionModel = {
  suggest: (input, signal) =>
    generateJson({
      purpose: "suggest",
      prompt: input.prompt,
      schema: input.schema,
      maxTokens: SUGGEST_MAX_TOKENS,
      deadlineMs: SUGGEST_DEADLINE_MS,
      signal,
    }),
  step: (input, signal) =>
    generateJson({
      purpose: "actions",
      prompt: input.prompt,
      schema: input.schema,
      maxTokens: STEP_MAX_TOKENS,
      deadlineMs: TURN_DEADLINE_MS,
      signal,
    }),
};

let override: ActionModel | null = null;

export function setActionModelForTests(model: ActionModel | null): void {
  override = model;
}

export function getActionModel(): ActionModel {
  if (override) return override;
  if (!providerConfigured()) throw new ModelUnconfiguredError(unconfiguredMessage());
  return providerActionModel;
}

export function stepDeadlineMs(jobStartedAt: number): number {
  const remaining = JOB_LIMIT_MS - (Date.now() - jobStartedAt);
  return Math.max(1, Math.min(TURN_DEADLINE_MS, remaining));
}
