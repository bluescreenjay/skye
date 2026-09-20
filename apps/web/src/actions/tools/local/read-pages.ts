import { gatherMaterial } from "../../../agents/context";
import { readPages } from "../../../agents/pages/read-pages";
import { PAGE_READ_MAX, PAGE_TEXT_CHARS } from "../../limits";
import type { ToolExecuteContext, ToolExecuteResult } from "../../registry";

export async function executeReadPages(ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
  const ids = Array.isArray(ctx.args.tabs) ? (ctx.args.tabs as string[]).slice(0, PAGE_READ_MAX) : [];
  const gathered = await gatherMaterial(ctx.userId, { id: ctx.workspaceId, name: ctx.workspaceName });
  const wanted = ids.map((id) => gathered.tabs.find((tab) => tab.id === id)).filter((tab): tab is NonNullable<typeof tab> => Boolean(tab));
  const outcomes = await readPages(wanted.map((tab) => ({ tabId: tab.id, url: tab.fetchUrl })));
  const byId = new Map(outcomes.map((outcome) => [outcome.tabId, outcome]));
  const lines = wanted.map((tab) => {
    const page = byId.get(tab.id);
    if (page?.text) return `${tab.id} ${tab.url}\n${page.text.slice(0, PAGE_TEXT_CHARS)}`;
    return `${tab.id} ${tab.url}\nnot read: ${page?.reason ?? "error"}`;
  });
  return { result: { kind: "text", text: lines.join("\n\n") || "No pages were read." } };
}
