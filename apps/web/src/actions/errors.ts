// What can go wrong with an action request or run, and the fixed sentences a person sees
// (specs/010b-mcp-action-tools/contracts/http.md). A message never contains a prompt, tab or
// page text, mail, a result, a secret, or a service's own words.
import type { ActionRequestErrorCode, ToolErrorCode } from "@ai-browser/shared";
import { describeFailure } from "../llm/situation";
import { AnswerError } from "../agents/errors";
import { ConnectorError } from "./integrations/connector";

export class ActionRequestError extends Error {
  readonly status: number;
  readonly code: ActionRequestErrorCode;

  constructor(status: number, code: ActionRequestErrorCode, message: string) {
    super(message);
    this.name = "ActionRequestError";
    this.status = status;
    this.code = code;
  }
}

export const notAWorkspace = () =>
  new ActionRequestError(400, "not_a_workspace", "Actions are for a workspace. Move these tabs into a workspace first.");
export const unknownTool = () => new ActionRequestError(404, "unknown_tool", "There is no such action.");
export const notAvailable = () => new ActionRequestError(403, "not_available", "That action isn't available.");
export const notConnected = (service: string) =>
  new ActionRequestError(
    409,
    "not_connected",
    ["google", "drive", "gmail", "calendar"].includes(service.toLowerCase())
      ? "Connect Google to use this action."
      : `Connect ${service} to use this action.`,
  );
export const invalidBody = () =>
  new ActionRequestError(400, "invalid_body", "That request wasn't in the expected form.");
export const badInput = (sentence: string) => new ActionRequestError(400, "bad_input", sentence);
export const precondition = (sentence: string) => new ActionRequestError(409, "precondition", sentence);
export const runInProgress = () => new ActionRequestError(409, "run_in_progress", "This action is already running.");
export const tooManyRuns = () =>
  new ActionRequestError(429, "too_many_runs", "Several actions are already running. Wait for one to finish.");
export const alreadyReported = () => new ActionRequestError(409, "already_reported", "That browser step was already reported.");
export const alreadySent = () => new ActionRequestError(409, "already_sent", "That message was already sent.");
export const cancelledPreview = () => new ActionRequestError(409, "cancelled", "That message was cancelled.");
export const expiredPreview = () =>
  new ActionRequestError(409, "expired", "This message was prepared too long ago. Prepare it again.");
export const invalidRecipient = () =>
  new ActionRequestError(400, "invalid_recipient", "Enter one email address, with no name or extra people.");
export const noSummary = () => new ActionRequestError(409, "no_summary", "Write a summary first.");
export const invalidFormat = () => new ActionRequestError(400, "invalid_format", "Export as md or pdf.");

export class ToolRunError extends Error {
  readonly code: ToolErrorCode;
  readonly partial: string | null;

  constructor(code: ToolErrorCode, message: string, partial: string | null = null) {
    super(message);
    this.name = "ToolRunError";
    this.code = code;
    this.partial = partial;
  }
}

const AGAIN = "You can try again.";
export const TIMED_OUT_MESSAGE = `This run did not finish. ${AGAIN}`;
export const BROWSER_FAILED_MESSAGE = `The browser did not respond. ${AGAIN}`;
export const STEP_LIMIT_MESSAGE = `This action stopped at its step limit. ${AGAIN}`;
export const REFUSED_ONLY_MESSAGE = `This action could not use the tools it asked for. ${AGAIN}`;
export const BAD_ANSWER_MESSAGE = `The AI's answer could not be used. ${AGAIN}`;
export const NO_SUMMARY_RUN_MESSAGE = `Write a summary first. ${AGAIN}`;
export const SERVICE_ERROR_MESSAGE = `That service didn't complete this action. ${AGAIN}`;
export const REJECTED_CREDENTIALS_MESSAGE = `Connect this service to use this action. ${AGAIN}`;
export const NOT_CONNECTED_RUN_MESSAGE = `Connect this service to use this action. ${AGAIN}`;
export const BAD_INPUT_RUN_MESSAGE = `That action's details weren't usable. ${AGAIN}`;

/** The stored failure of a run: a code with a fixed sentence. Never copies vendor or page text. */
export function failureFor(error: unknown, options: { timedOut?: boolean; partial?: string | null } = {}): {
  code: ToolErrorCode;
  message: string;
  partial: string | null;
} {
  const partial = options.partial ?? null;
  if (options.timedOut) return { code: "timed_out", message: TIMED_OUT_MESSAGE, partial };
  if (error instanceof ToolRunError) return { code: error.code, message: error.message, partial: error.partial ?? partial };
  if (error instanceof ConnectorError) {
    const code = error.code === "not_connected" || error.code === "rejected_credentials" || error.code === "timed_out" ? error.code : "service_error";
    return { code, message: error.message, partial };
  }
  if (error instanceof ActionRequestError) {
    if (error.code === "not_connected") return { code: "not_connected", message: NOT_CONNECTED_RUN_MESSAGE, partial };
    if (error.code === "no_summary" || error.code === "precondition") return { code: "no_summary", message: NO_SUMMARY_RUN_MESSAGE, partial };
    if (error.code === "bad_input") return { code: "bad_input", message: BAD_INPUT_RUN_MESSAGE, partial };
  }
  if (error instanceof AnswerError) return { code: "bad_answer", message: BAD_ANSWER_MESSAGE, partial };
  switch (describeFailure(error)) {
    case "busy":
      return { code: "budget_exhausted", message: `The AI assistant is busy right now. ${AGAIN}`, partial };
    case "quota":
      return { code: "budget_exhausted", message: `The AI service's quota has been reached. ${AGAIN}`, partial };
    case "daily":
      return { code: "budget_exhausted", message: `The daily AI limit has been reached. ${AGAIN}`, partial };
    case "vpn":
      return { code: "model_error", message: "The AI service is only reachable on the VT VPN. Connect to it and try again.", partial };
    default:
      return { code: "model_error", message: `The AI assistant couldn't run this right now. ${AGAIN}`, partial };
  }
}
