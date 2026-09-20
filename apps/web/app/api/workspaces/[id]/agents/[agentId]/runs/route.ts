import type { AgentRunPage } from "@ai-browser/shared";
import { getAgent } from "@/src/agents/catalog";
import { AgentRequestError, invalidCursor, unknownAgent } from "@/src/agents/errors";
import { authorizeWorkspace } from "@/src/agents/guard";
import { listRuns } from "@/src/agents/runs";
import { errorJson, json, optionsResponse } from "@/src/json";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; agentId: string }> };

export function OPTIONS() {
  return optionsResponse();
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 10;

/** `limit`: 1 to 10; missing, not a number, or below 1 means 10, and more than 10 means 10. */
function pageSize(raw: string | null): number {
  const n = Math.floor(Number(raw));
  if (raw === null || raw.trim() === "" || !Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/** An agent's stored runs in this workspace, newest first. Makes no AI call. */
export async function GET(request: Request, context: Context) {
  const auth = await authorizeWorkspace(request, context);
  if (auth.response) return auth.response;
  try {
    const { agentId } = await context.params;
    if (!getAgent(agentId)) throw unknownAgent();
    const url = new URL(request.url);
    const before = url.searchParams.get("before") ?? undefined;
    const page = await listRuns(auth.userId, auth.workspace.id, agentId, { limit: pageSize(url.searchParams.get("limit")), beforeId: before });
    if (!page) throw invalidCursor();
    const body: AgentRunPage = page;
    return json(body);
  } catch (caught) {
    if (caught instanceof AgentRequestError) return json({ error: caught.message, code: caught.code }, caught.status);
    // Only the error's class name is logged: never a result, a title, or a vendor body.
    console.error("agent runs read failed:", caught instanceof Error ? caught.name : "unknown");
    return errorJson("Runs failed", 500);
  }
}
