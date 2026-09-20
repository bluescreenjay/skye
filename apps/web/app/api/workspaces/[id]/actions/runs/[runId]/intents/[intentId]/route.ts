import { ActionRequestError, invalidBody, notAWorkspace } from "@/src/actions/errors";
import { parseIntentReport, reportIntent } from "@/src/actions/intents";
import { requireUser } from "@/src/auth";
import { findWorkspace } from "@/src/chat/messages";
import { errorJson, json, optionsResponse } from "@/src/json";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; runId: string; intentId: string }> };

export function OPTIONS() {
  return optionsResponse();
}

export async function POST(request: Request, context: Context) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  const { id, runId, intentId } = await context.params;
  if (id === "other") {
    const refused = notAWorkspace();
    return json({ error: refused.message, code: refused.code }, refused.status);
  }
  const workspace = await findWorkspace(user!.id, id);
  if (!workspace) return errorJson("Workspace not found", 404);
  try {
    let body: unknown = {};
    const raw = await request.text();
    if (raw.trim() !== "") {
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        const err = invalidBody();
        return json({ error: err.message, code: err.code }, err.status);
      }
    }
    const run = await reportIntent(user!.id, workspace.id, runId, intentId, parseIntentReport(body));
    return json({ run });
  } catch (caught) {
    if (caught instanceof ActionRequestError) return json({ error: caught.message, code: caught.code }, caught.status);
    if ((caught as { http?: number }).http === 404) return errorJson("Workspace not found", 404);
    console.error("intent report failed:", caught instanceof Error ? caught.name : "unknown");
    return errorJson("Run failed", 500);
  }
}
