// list_workspace_tabs: this workspace's saved tabs only (FR-019).
import { gatherMaterial } from "../../../agents/context";
import { MAX_TABS_LISTED, TAB_EXCERPT_CHARS } from "../../limits";
import type { ToolExecuteContext, ToolExecuteResult } from "../../registry";

export async function executeListTabs(ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
  const gathered = await gatherMaterial(ctx.userId, { id: ctx.workspaceId, name: ctx.workspaceName });
  const lines = gathered.tabs.slice(0, MAX_TABS_LISTED).map((tab) => {
    const excerpt = tab.excerpt.slice(0, TAB_EXCERPT_CHARS);
    return `${tab.id}: ${tab.title}\n${tab.url}${excerpt ? `\n${excerpt}` : ""}`;
  });
  const text = lines.length === 0 ? "This workspace has no saved web tabs." : lines.join("\n\n");
  return { result: { kind: "text", text } };
}
