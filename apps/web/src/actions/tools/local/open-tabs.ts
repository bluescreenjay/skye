import { randomUUID } from "crypto";
import type { OpenSkipReason } from "@ai-browser/shared";
import { checkAddress } from "../../../agents/pages/safe-address";
import { SEARCHES_OPENED_MAX, TABS_OPENED_MAX } from "../../limits";
import type { ToolExecuteContext, ToolExecuteResult } from "../../registry";

function filterUrls(urls: string[], limit: number): { kept: string[]; skipped: { url: string; reason: OpenSkipReason }[] } {
  const kept: string[] = [];
  const skipped: { url: string; reason: OpenSkipReason }[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    if (kept.length >= limit) {
      skipped.push({ url, reason: "over_limit" });
      continue;
    }
    const checked = checkAddress(url);
    if (!checked.ok) {
      skipped.push({ url, reason: checked.reason });
      continue;
    }
    if (seen.has(checked.plain)) {
      skipped.push({ url, reason: "duplicate" });
      continue;
    }
    seen.add(checked.plain);
    kept.push(checked.plain);
  }
  return { kept, skipped };
}

export async function executeOpenTabs(ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
  const urls = Array.isArray(ctx.args.urls) ? (ctx.args.urls as string[]) : [];
  const placeInWorkspace = ctx.args.placeInWorkspace === true;
  const { kept, skipped } = filterUrls(urls, TABS_OPENED_MAX);
  return {
    result: { kind: "opened", opened: 0, failed: 0, skipped, placed: null },
    intents: [
      {
        id: randomUUID(),
        kind: "open_tabs",
        urls: kept,
        placeInWorkspace,
        workspaceId: ctx.workspaceId,
      },
    ],
  };
}

export async function executeOpenSearches(ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
  const queries = Array.isArray(ctx.args.queries) ? (ctx.args.queries as string[]) : [];
  const urls = queries.slice(0, SEARCHES_OPENED_MAX).map((query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`);
  const placeInWorkspace = ctx.args.placeInWorkspace === true;
  return {
    result: { kind: "opened", opened: 0, failed: 0, skipped: [], placed: null },
    intents: [
      {
        id: randomUUID(),
        kind: "open_tabs",
        urls,
        placeInWorkspace,
        workspaceId: ctx.workspaceId,
      },
    ],
  };
}
