import type { SuggestionSet } from "@ai-browser/shared";
import { requireUser } from "@/src/auth";
import { findWorkspace } from "@/src/chat/messages";
import { ActionRequestError, invalidBody, notAWorkspace } from "@/src/actions/errors";
import { runSuggestPass } from "@/src/actions/suggest/pass";
import { errorJson, json, optionsResponse } from "@/src/json";
import { ModelUnconfiguredError } from "@/src/llm/errors";
import type { RouteContext } from "@/src/agents/guard";

export const runtime = "nodejs";

export function OPTIONS() {
  return optionsResponse();
}

export async function POST(request: Request, context: RouteContext) {
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
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      const err = invalidBody();
      return json({ error: err.message, code: err.code }, err.status);
    }
    const force = (body as { force?: unknown }).force;
    if (force !== undefined && typeof force !== "boolean") {
      const err = invalidBody();
      return json({ error: err.message, code: err.code }, err.status);
    }
    const set: SuggestionSet = await runSuggestPass({ userId: user!.id, workspace, force: force === true });
    return json(set);
  } catch (caught) {
    if (caught instanceof ActionRequestError) return json({ error: caught.message, code: caught.code }, caught.status);
    if (caught instanceof ModelUnconfiguredError) {
      return json({ error: "The AI assistant isn't set up on this server yet.", code: "model_unconfigured" }, 503);
    }
    console.error("actions suggest failed:", caught instanceof Error ? caught.name : "unknown");
    return errorJson("Actions failed", 500);
  }
}
