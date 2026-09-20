// Host executor for browser intents started from Home (feature 010b). Under home/, so observe-only
// does not scan it. Never closes, moves, or changes an existing tab.
import type { BrowserIntent } from "@ai-browser/shared";
import { loadConfig } from "../config";
import { moveTab } from "../corrections/api";
import type { IntentCounts } from "../ui/actions";
import { isHttpsUrl } from "../ui/actions";

const PLACE_TRIES = 4;
const PLACE_WAIT_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeActionIntents(intents: BrowserIntent[], workspaceId: string): Promise<IntentCounts> {
  const counts: IntentCounts = { opened: 0, failed: 0, placed: 0 };
  const config = loadConfig(import.meta.env);
  for (const intent of intents) {
    if (intent.kind === "download") {
      if (!config.ok) {
        counts.failed += 1;
        continue;
      }
      try {
        const response = await fetch(
          `${config.config.apiBaseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/summary/export?format=${intent.format}`,
          { headers: { Authorization: `Bearer ${config.config.deviceToken}` } },
        );
        if (!response.ok) {
          counts.failed += 1;
          continue;
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = intent.filename;
        a.click();
        URL.revokeObjectURL(url);
        counts.opened += 1;
      } catch {
        counts.failed += 1;
      }
      continue;
    }
    for (const url of intent.urls) {
      if (!isHttpsUrl(url)) {
        counts.failed += 1;
        continue;
      }
      try {
        const tab = await chrome.tabs.create({ url, active: false });
        counts.opened += 1;
        if (intent.placeInWorkspace && tab.id !== undefined) {
          const placed = await placeNewTab(tab.id, url, workspaceId);
          if (placed) counts.placed += 1;
        }
      } catch {
        counts.failed += 1;
      }
    }
  }
  return counts;
}

async function placeNewTab(chromeTabId: number, url: string, workspaceId: string): Promise<boolean> {
  const config = loadConfig(import.meta.env);
  if (!config.ok) return false;
  for (let i = 0; i < PLACE_TRIES; i += 1) {
    try {
      const resolveUrl = new URL("/api/resolve", config.config.apiBaseUrl);
      resolveUrl.searchParams.set("chromeTabId", String(chromeTabId));
      resolveUrl.searchParams.set("url", url);
      const response = await fetch(resolveUrl.toString(), { headers: { Authorization: `Bearer ${config.config.deviceToken}` } });
      if (response.ok) {
        const body = (await response.json()) as { tabRef?: { id?: string } };
        if (body.tabRef?.id) {
          const moved = await moveTab(body.tabRef.id, workspaceId);
          return moved.ok;
        }
      }
    } catch {
      // retry
    }
    await sleep(PLACE_WAIT_MS);
  }
  return false;
}

export function shouldRetryPlacement(attempt: number): boolean {
  return attempt < PLACE_TRIES;
}
