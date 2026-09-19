import { requireUser } from "@/src/auth";
import { errorJson, json, optionsResponse } from "@/src/json";
import { acceptSuggestion, SuggestionNotFound, SuggestionNotPending, SuggestionStale } from "@/src/cluster/suggestions";

export const runtime = "nodejs";

export function OPTIONS() {
  return optionsResponse();
}

/** Accept a suggestion: its still-unplaced tabs go to the workspace as the user's own placement. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  const { id } = await context.params;

  try {
    return json(await acceptSuggestion(user!.id, id));
  } catch (err) {
    if (err instanceof SuggestionNotFound) return errorJson(err.message, 404);
    if (err instanceof SuggestionNotPending) return json({ error: err.message, code: "not_pending" }, 409);
    if (err instanceof SuggestionStale) return json({ error: err.message, code: "stale" }, 409);
    // Never log the error object: a database error can carry query text or values.
    console.error("[suggestions] accept failed", (err as Error)?.name ?? "Error");
    return errorJson("Could not accept the suggestion", 500);
  }
}
