// What can go wrong with an agent request or run, and the fixed sentences a person sees
// (specs/010-workspace-agents/contracts/http.md). A message never contains a prompt, tab or
// page text, a result, or the AI service's own words.
import type { AgentErrorCode, AgentRequestErrorCode } from "@ai-browser/shared";
import { describeFailure } from "../llm/situation";

/** A refused request: an HTTP status, a code a client can act on, and a fixed message. */
export class AgentRequestError extends Error {
  readonly status: number;
  readonly code: AgentRequestErrorCode;

  constructor(status: number, code: AgentRequestErrorCode, message: string) {
    super(message);
    this.name = "AgentRequestError";
    this.status = status;
    this.code = code;
  }
}

export const notAWorkspace = () =>
  new AgentRequestError(400, "not_a_workspace", "Agents are for a workspace. Move these tabs into a workspace first.");
export const unknownAgent = () => new AgentRequestError(404, "unknown_agent", "There is no such agent.");
export const runInProgress = () => new AgentRequestError(409, "run_in_progress", "This agent is already running for this workspace.");
export const noTabs = () => new AgentRequestError(409, "no_tabs", "Add some web tabs to this workspace first, then run an agent.");
export const tooManyRuns = () => new AgentRequestError(429, "too_many_runs", "Several agents are already running. Wait for one to finish.");
export const invalidCursor = () => new AgentRequestError(400, "invalid_cursor", "That page marker is not a run of this agent in this workspace.");
export const invalidBody = () => new AgentRequestError(400, "invalid_body", 'Send { "done": true } or { "done": false }.');

/** The AI's answer could not be used (empty, or nothing valid left after cleaning). */
export class AnswerError extends Error {
  constructor(message = "The AI's answer could not be used.") {
    super(message);
    this.name = "AnswerError";
  }
}

const AGAIN = "You can run it again";
export const TIMED_OUT_MESSAGE = `This run did not finish. ${AGAIN}.`;

/** The stored failure of a run: one of four codes with a fixed sentence. */
export function failureFor(error: unknown, options: { timedOut?: boolean } = {}): { code: AgentErrorCode; message: string } {
  if (options.timedOut) return { code: "timed_out", message: TIMED_OUT_MESSAGE };
  if (error instanceof AnswerError) return { code: "bad_answer", message: `The AI's answer could not be used. ${AGAIN}.` };
  switch (describeFailure(error)) {
    case "busy":
      return { code: "budget_exhausted", message: `The AI assistant is busy right now. ${AGAIN} in a moment.` };
    case "quota":
      return { code: "budget_exhausted", message: `The AI service's quota has been reached. ${AGAIN} later.` };
    case "daily":
      return { code: "budget_exhausted", message: `The daily AI limit has been reached. ${AGAIN} tomorrow.` };
    case "vpn":
      return { code: "model_error", message: "The AI service is only reachable on the VT VPN. Connect to it and run it again." };
    default:
      return { code: "model_error", message: `The AI assistant couldn't run this right now. ${AGAIN}.` };
  }
}
