import { requireUser } from "@/src/auth";
import { applyAction } from "@/src/command/apply";
import { CommandRequestError } from "@/src/command/errors";
import { parseApplyBody } from "@/src/command/guard";
import { COMMAND_FAILED } from "@/src/command/messages";
import { errorJson, json, optionsResponse } from "@/src/json";

export const runtime = "nodejs";
// An organize waits on the AI service like Home's organize button does.
export const maxDuration = 60;

export function OPTIONS() {
  return optionsResponse();
}

/** Do a resolved action, or answer `needs_confirmation` with exactly what it would change (contracts/http.md). */
export async function POST(request: Request) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  try {
    const { action, confirmed } = await parseApplyBody(request);
    return json(await applyAction(user!.id, action, confirmed));
  } catch (caught) {
    if (caught instanceof CommandRequestError) return json({ error: caught.message, code: caught.code }, caught.status);
    console.error("[command] apply failed", caught instanceof Error ? caught.name : "unknown");
    return errorJson(COMMAND_FAILED, 500);
  }
}
