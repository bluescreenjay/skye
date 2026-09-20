import { AgentRequestError, unknownAgent } from "@/src/agents/errors";
import { getAgent } from "@/src/agents/catalog";
import { authorizeWorkspace } from "@/src/agents/guard";
import { startAgentRun } from "@/src/agents/run";
import { errorJson, json, optionsResponse } from "@/src/json";
import { ModelUnconfiguredError } from "@/src/llm/errors";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; agentId: string }> };

export function OPTIONS() {
  return optionsResponse();
}

/** Press an agent. Returns at once with a running run; the job carries on in this server. */
export async function POST(request: Request, context: Context) {
  const auth = await authorizeWorkspace(request, context);
  if (auth.response) return auth.response;
  try {
    const { agentId } = await context.params;
    const agent = getAgent(agentId);
    if (!agent) throw unknownAgent();
    const run = await startAgentRun(auth.userId, auth.workspace, agent);
    return json({ run }, 202);
  } catch (caught) {
    if (caught instanceof AgentRequestError) return json({ error: caught.message, code: caught.code }, caught.status);
    if (caught instanceof ModelUnconfiguredError) {
      return json({ error: "The AI assistant isn't set up on this server yet.", code: "model_unconfigured" }, 503);
    }
    // Only the error's class name is logged: never a title, a result, or a vendor body.
    console.error("agent run failed:", caught instanceof Error ? caught.name : "unknown");
    return errorJson("Run failed", 500);
  }
}
