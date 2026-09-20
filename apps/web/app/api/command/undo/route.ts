import { requireUser } from "@/src/auth";
import { query } from "@/src/db";
import { COMMAND_FAILED } from "@/src/command/messages";
import { readUndo } from "@/src/command/undo";
import { errorJson, json, optionsResponse } from "@/src/json";

export const runtime = "nodejs";

export function OPTIONS() {
  return optionsResponse();
}

/** What can be undone right now, or null. Makes no AI request (contracts/http.md). */
export async function GET(request: Request) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  try {
    return json({ undo: await readUndo({ query }, user!.id) });
  } catch (caught) {
    console.error("[command] undo state failed", caught instanceof Error ? caught.name : "unknown");
    return errorJson(COMMAND_FAILED, 500);
  }
}
