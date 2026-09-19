import { requireUser } from "@/src/auth";
import { errorJson, json, optionsResponse } from "@/src/json";
import { ignoreSuggestion, SuggestionNotFound, SuggestionNotPending } from "@/src/cluster/suggestions";

export const runtime = "nodejs";

export function OPTIONS() {
  return optionsResponse();
}

/** Dismiss a suggestion. It is neither offered again nor auto-applied unless its tabs materially change. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  const { id } = await context.params;

  try {
    return json({ suggestion: await ignoreSuggestion(user!.id, id) });
  } catch (err) {
    if (err instanceof SuggestionNotFound) return errorJson(err.message, 404);
    if (err instanceof SuggestionNotPending) return json({ error: err.message, code: "not_pending" }, 409);
    console.error("[suggestions] ignore failed", (err as Error)?.name ?? "Error");
    return errorJson("Could not ignore the suggestion", 500);
  }
}
