import { gatherMaterial } from "../../../agents/context";
import { readPages } from "../../../agents/pages/read-pages";
import { normalizeForMatch } from "../../../agents/validate";
import { addRefs } from "../../notes";
import type { ToolExecuteContext, ToolExecuteResult } from "../../registry";

export async function executeSaveRefs(ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
  const refs = Array.isArray(ctx.args.refs) ? (ctx.args.refs as { quote?: string; tab?: string }[]) : [];
  const gathered = await gatherMaterial(ctx.userId, { id: ctx.workspaceId, name: ctx.workspaceName });
  const byId = new Map(gathered.tabs.map((tab) => [tab.id, tab]));
  const toRead = gathered.tabs.map((tab) => ({ tabId: tab.id, url: tab.fetchUrl }));
  const pages = new Map((await readPages(toRead)).map((page) => [page.tabId, page]));
  const verified: { quote: string; url: string }[] = [];
  let refused = 0;
  for (const ref of refs) {
    const quote = typeof ref.quote === "string" ? ref.quote : "";
    const tab = typeof ref.tab === "string" ? byId.get(ref.tab) : undefined;
    if (!tab || !quote) {
      refused += 1;
      continue;
    }
    const page = pages.get(tab.id);
    const material = `${tab.excerpt}\n${page?.text ?? ""}`;
    if (!normalizeForMatch(material).includes(normalizeForMatch(quote))) {
      refused += 1;
      continue;
    }
    verified.push({ quote, url: tab.url });
  }
  const count = await addRefs(ctx.userId, ctx.workspaceId, verified);
  return { result: { kind: "saved", what: "refs", added: count.added, skippedDuplicates: count.skippedDuplicates, refused: refused + count.refused } };
}
