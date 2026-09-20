// What can go wrong with a command request, and the fixed sentences a person sees
// (specs/011-global-command-bar/contracts/http.md). A message never contains a command, a tab or
// workspace title, a result, or the AI service's own words.
import type { CommandRefusalCode, CommandRequestErrorCode } from "@ai-browser/shared";
import { BudgetExceededError, ModelError, ModelUnconfiguredError } from "../llm/errors";
import { describeFailure } from "../llm/situation";
import { RunInProgress } from "../cluster/run";
import * as m from "./messages";

/** A refused request: an HTTP status, a code a client can act on, and a fixed message. */
export class CommandRequestError extends Error {
  readonly status: number;
  readonly code: CommandRequestErrorCode;

  constructor(status: number, code: CommandRequestErrorCode, message: string) {
    super(message);
    this.name = "CommandRequestError";
    this.status = status;
    this.code = code;
  }
}

export const textEmpty = () => new CommandRequestError(400, "text_empty", m.TEXT_EMPTY);
export const textTooLong = () => new CommandRequestError(400, "text_too_long", m.TEXT_TOO_LONG);
export const badContext = () => new CommandRequestError(400, "bad_context", m.BAD_CONTEXT);
export const badTimeZone = () => new CommandRequestError(400, "bad_time_zone", m.BAD_TIME_ZONE);
export const badAction = () => new CommandRequestError(400, "bad_action", m.BAD_ACTION);

/** The interpret call failed: which status, code, and sentence to answer with. */
export function interpretFailure(error: unknown): { status: 429 | 502 | 503; code: CommandRequestErrorCode; message: string } {
  switch (describeFailure(error)) {
    case "unconfigured":
      return { status: 503, code: "model_unconfigured", message: m.AI_UNCONFIGURED };
    case "busy":
      return { status: 503, code: "busy", message: m.AI_BUSY };
    case "quota":
      return { status: 429, code: "budget_exhausted", message: m.AI_QUOTA };
    case "daily":
      return { status: 429, code: "budget_exhausted", message: m.AI_DAILY };
    case "vpn":
      return { status: 502, code: "model_error", message: m.AI_VPN };
    default:
      return { status: 502, code: "model_error", message: m.AI_FAILED };
  }
}

/** An organize (or its undo) ended in a typed error: the refusal a client can act on, or null when it is not one of ours. */
export function applyRefusal(error: unknown): { code: CommandRefusalCode; message: string } | null {
  if (error instanceof RunInProgress) return { code: "run_in_progress", message: m.REFUSAL.run_in_progress };
  if (error instanceof ModelUnconfiguredError) return { code: "model_unconfigured", message: m.REFUSAL.model_unconfigured };
  if (error instanceof BudgetExceededError) {
    const situation = describeFailure(error);
    return { code: "budget_exhausted", message: situation === "busy" ? m.AI_BUSY : situation === "quota" ? m.AI_QUOTA : m.AI_DAILY };
  }
  if (error instanceof ModelError) return { code: "model_error", message: m.REFUSAL.model_error };
  return null;
}
