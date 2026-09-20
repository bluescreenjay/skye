import { ActionRequestError, invalidBody } from "@/src/actions/errors";
import { parseRunBody, startToolRun } from "@/src/actions/run";
import { requireUser } from "@/src/auth";
import { findWorkspace } from "@/src/chat/messages";
import { notAWorkspace } from "@/src/actions/errors";
import { errorJson, json, optionsResponse } from "@/src/json";
import { ModelUnconfiguredError } from "@/src/llm/errors";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; toolId: string }> };

export function OPTIONS() {
  return optionsResponse();
}

export async function POST(request: Request, context: Context) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  const { id, toolId } = await context.params;
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
    const parsed = parseRunBody(body);
    const started = await startToolRun(user!.id, workspace, toolId, parsed);
    if (toolId === "gmail_search_messages") return json({ run: started.run, mail: { messages: started.mail ?? [] } }, 200);
    return json({ run: started.run }, 202);
  } catch (caught) {
    if (caught instanceof ActionRequestError) return json({ error: caught.message, code: caught.code }, caught.status);
    if (caught instanceof ModelUnconfiguredError) {
      return json({ error: "The AI assistant isn't set up on this server yet.", code: "model_unconfigured" }, 503);
    }
    console.error("action run failed:", caught instanceof Error ? caught.name : "unknown");
    return errorJson("Run failed", 500);
  }
}
