import type { WorkspaceAgents } from "@ai-browser/shared";
import { listPlanItems } from "@/src/agents/plan-items";
import { authorizeWorkspace, type RouteContext } from "@/src/agents/guard";
import { readEntries } from "@/src/agents/runs";
import { errorJson, json, optionsResponse } from "@/src/json";

export const runtime = "nodejs";

export function OPTIONS() {
  return optionsResponse();
}

/** The whole agents card in one read: each agent's latest result, its running run, its latest failure, and the checklist. Makes no AI call. */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizeWorkspace(request, context);
  if (auth.response) return auth.response;
  try {
    const body: WorkspaceAgents = {
      agents: await readEntries(auth.userId, auth.workspace.id),
      planItems: await listPlanItems(auth.userId, auth.workspace.id),
    };
    return json(body);
  } catch (caught) {
    // Only the error's class name is logged: never a title, a result, or a vendor body.
    console.error("agents read failed:", caught instanceof Error ? caught.name : "unknown");
    return errorJson("Agents failed", 500);
  }
}
