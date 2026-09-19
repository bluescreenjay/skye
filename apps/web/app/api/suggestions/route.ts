import { requireUser } from "@/src/auth";
import { errorJson, json, optionsResponse } from "@/src/json";
import { listSuggestions, type SuggestionFilter } from "@/src/cluster/suggestions";

export const runtime = "nodejs";

const FILTERS: SuggestionFilter[] = ["pending", "accepted", "ignored", "all"];

export function OPTIONS() {
  return optionsResponse();
}

/**
 * This user's suggestions, newest first. `status` = pending (default) | accepted | ignored | all.
 * Each one lists only its tabs that are still unplaced; a pending suggestion left with
 * fewer than two is withdrawn during this call and not returned.
 */
export async function GET(request: Request) {
  const { user, error } = await requireUser(request);
  if (error) return error;

  const status = new URL(request.url).searchParams.get("status") ?? "pending";
  if (!FILTERS.includes(status as SuggestionFilter)) {
    return errorJson(`status must be one of ${FILTERS.join(", ")}`, 400);
  }
  return json({ suggestions: await listSuggestions(user!.id, status as SuggestionFilter) });
}
