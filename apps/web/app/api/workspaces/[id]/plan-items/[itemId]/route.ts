import { invalidBody } from "@/src/agents/errors";
import { authorizeWorkspace } from "@/src/agents/guard";
import { tickPlanItem } from "@/src/agents/plan-items";
import { errorJson, json, optionsResponse } from "@/src/json";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; itemId: string }> };

export function OPTIONS() {
  return optionsResponse();
}

/** Tick or untick one checklist item of this person's workspace. */
export async function PATCH(request: Request, context: Context) {
  const auth = await authorizeWorkspace(request, context);
  if (auth.response) return auth.response;

  const bad = () => json({ error: invalidBody().message, code: invalidBody().code }, 400);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad();
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad();
  const done = (body as { done?: unknown }).done;
  if (typeof done !== "boolean") return bad();

  try {
    const { itemId } = await context.params;
    const planItem = await tickPlanItem(auth.userId, auth.workspace.id, itemId, done);
    if (!planItem) return errorJson("Plan item not found", 404);
    return json({ planItem });
  } catch (caught) {
    // Only the error's class name is logged: never an item's text.
    console.error("plan item update failed:", caught instanceof Error ? caught.name : "unknown");
    return errorJson("Update failed", 500);
  }
}
