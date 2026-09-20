// Who may use which tools right now (specs/010b-mcp-action-tools/research.md section 3).
// Used by the suggestion pass AND every click route. Non-owner Google tools are simply absent.
import type { IntegrationId } from "@ai-browser/shared";
import type { DbWorkspace } from "../map";
import { gatherMaterial, type Gathered } from "../agents/context";
import { allTools, type AccessFacts, type ToolDef } from "./registry";
import { connectionStatus, isOwner } from "./integrations/config";
import { listQueries, listSummary, type SavedSummary } from "./notes";

export function allowedTools(userId: string, facts: AccessFacts): ToolDef[] {
  const owner = isOwner(userId);
  return allTools().filter((tool) => {
    if (tool.ownerOnly && !owner) return false;
    if (tool.integration && connectionStatus(tool.integration) !== "connected") return false;
    if (tool.preconditions(facts)) return false;
    return true;
  });
}

export function toolAllowedFor(userId: string, tool: ToolDef, facts: AccessFacts): "ok" | "not_available" | "not_connected" | "precondition" {
  if (tool.ownerOnly && !isOwner(userId)) return "not_available";
  if (tool.integration && connectionStatus(tool.integration) !== "connected") return "not_connected";
  if (tool.preconditions(facts)) return "precondition";
  return "ok";
}

export function connectedIntegrations(userId: string): IntegrationId[] {
  const owner = isOwner(userId);
  const ids: IntegrationId[] = ["github", "jira", "notion", "slack", "drive", "gmail", "calendar"];
  return ids.filter((id) => {
    if ((id === "drive" || id === "gmail" || id === "calendar") && !owner) return false;
    return connectionStatus(id) === "connected";
  });
}

export async function loadWorkspaceFacts(
  userId: string,
  workspace: Pick<DbWorkspace, "id" | "name">,
): Promise<{ facts: AccessFacts; gathered: Gathered; summary: SavedSummary | null; queries: string[] }> {
  const [gathered, summary, queries] = await Promise.all([
    gatherMaterial(userId, workspace),
    listSummary(userId, workspace.id),
    listQueries(userId, workspace.id),
  ]);
  return {
    facts: {
      hasSummary: summary !== null,
      hasWebTabs: gathered.tabs.length > 0,
      queryCount: queries.length,
      planCount: gathered.plan.length,
    },
    gathered,
    summary,
    queries,
  };
}
