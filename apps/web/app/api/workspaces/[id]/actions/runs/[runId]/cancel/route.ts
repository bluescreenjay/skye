import { ActionRequestError, notAWorkspace } from "@/src/actions/errors";
import { cancelSend } from "@/src/actions/confirm";
import { requireUser } from "@/src/auth";
import { findWorkspace } from "@/src/chat/messages";
import { errorJson, json, optionsResponse } from "@/src/json";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; runId: string }> };

export function OPTIONS() {
  return optionsResponse();
}

export async function POST(request: Request, context: Context) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  const { id, runId } = await context.params;
  if (id === "other") {
    const refused = notAWorkspace();
    return json({ error: refused.message, code: refused.code }, refused.status);
  }
  const workspace = await findWorkspace(user!.id, id);
  if (!workspace) return errorJson("Workspace not found", 404);
  try {
    const run = await cancelSend(user!.id, workspace.id, runId);
    return json({ run });
  } catch (caught) {
    if (caught instanceof ActionRequestError) return json({ error: caught.message, code: caught.code }, caught.status);
    if ((caught as { http?: number }).http === 404) return errorJson("Not found", 404);
    console.error("cancel failed:", caught instanceof Error ? caught.name : "unknown");
    return errorJson("Run failed", 500);
  }
}
