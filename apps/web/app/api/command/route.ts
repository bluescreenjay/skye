import { requireUser } from "@/src/auth";
import { CommandRequestError, interpretFailure } from "@/src/command/errors";
import { parseRequest } from "@/src/command/guard";
import { interpretCommand } from "@/src/command/interpret";
import { COMMAND_FAILED } from "@/src/command/messages";
import { errorJson, json, optionsResponse } from "@/src/json";
import { BudgetExceededError, ModelError, ModelUnconfiguredError } from "@/src/llm/errors";

export const runtime = "nodejs";
// The one AI request has its own 20 s deadline (src/command/limits.ts); leave room for the rest.
export const maxDuration = 60;

export function OPTIONS() {
  return optionsResponse();
}

/** Interpret one command (contracts/http.md). Makes exactly one AI request and changes nothing. */
export async function POST(request: Request) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  try {
    const { text, context } = await parseRequest(request);
    return json(await interpretCommand(user!.id, { text, context }));
  } catch (caught) {
    if (caught instanceof CommandRequestError) return json({ error: caught.message, code: caught.code }, caught.status);
    if (caught instanceof ModelUnconfiguredError || caught instanceof BudgetExceededError || caught instanceof ModelError || (caught instanceof Error && caught.name === "AbortError")) {
      const failure = interpretFailure(caught);
      return json({ error: failure.message, code: failure.code }, failure.status);
    }
    // Only the error's class name is logged: never a command, a title, or a vendor body.
    console.error("[command] failed", caught instanceof Error ? caught.name : "unknown");
    return errorJson(COMMAND_FAILED, 500);
  }
}
