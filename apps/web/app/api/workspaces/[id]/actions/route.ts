import type { WorkspaceActions } from "@ai-browser/shared";
import { requireUser } from "@/src/auth";
import { findWorkspace } from "@/src/chat/messages";
import { notAWorkspace } from "@/src/actions/errors";
import { readWorkspaceActions } from "@/src/actions/runs";
import { errorJson, json, optionsResponse } from "@/src/json";
import type { RouteContext } from "@/src/agents/guard";

export const runtime = "nodejs";

export function OPTIONS() {
  return optionsResponse();
}

export async function GET(request: Request, context: RouteContext) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  const { id } = await context.params;
  if (id === "other") {
    const refused = notAWorkspace();
    return json({ error: refused.message, code: refused.code }, refused.status);
  }
  const workspace = await findWorkspace(user!.id, id);
  if (!workspace) return errorJson("Workspace not found", 404);
  try {
    const body: WorkspaceActions = await readWorkspaceActions(user!.id, workspace.id);
    return json(body);
  } catch (caught) {
    console.error("actions read failed:", caught instanceof Error ? caught.name : "unknown");
    return errorJson("Actions failed", 500);
  }
}
