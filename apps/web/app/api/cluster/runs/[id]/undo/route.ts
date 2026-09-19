import { requireUser } from "@/src/auth";
import { errorJson, json, optionsResponse } from "@/src/json";
import { RunNotFound, RunNotUndoable, undoRun } from "@/src/cluster/undo";

export const runtime = "nodejs";

export function OPTIONS() {
  return optionsResponse();
}

/**
 * Take back what a run did. Only tabs still ai-placed where the run put them are
 * reverted; workspaces the run created that are now empty and untouched are archived.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  const { id } = await context.params;

  try {
    return json(await undoRun(user!.id, id));
  } catch (err) {
    if (err instanceof RunNotFound) return errorJson(err.message, 404);
    if (err instanceof RunNotUndoable) return json({ error: err.message, code: "not_undoable" }, 409);
    console.error("[cluster] undo failed", (err as Error)?.name ?? "Error");
    return errorJson("Could not undo the run", 500);
  }
}
