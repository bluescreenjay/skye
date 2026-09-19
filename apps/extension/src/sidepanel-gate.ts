// Closes/disables the Side Panel on Home and other non-web tabs.
// enabled:false alone often leaves a still-open panel visible; we also call close().
import { isEligibleUrl } from "./filters";

export function isHomeUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "chrome-extension:" &&
      parsed.hostname === chrome.runtime.id &&
      (parsed.pathname === "/home.html" || parsed.pathname.endsWith("/home.html"))
    );
  } catch {
    return false;
  }
}

async function closePanelForTab(tab: { id: number; windowId?: number }): Promise<void> {
  const sidePanel = chrome.sidePanel as typeof chrome.sidePanel & {
    close?: (options: { tabId?: number; windowId?: number }) => Promise<void>;
  };
  if (typeof sidePanel.close !== "function") return;
  try {
    if (typeof tab.windowId === "number") {
      await sidePanel.close({ windowId: tab.windowId });
      return;
    }
    await sidePanel.close({ tabId: tab.id });
  } catch {
    // Already closed, or Chrome build without close support for this context.
  }
}

/** Keep the panel available on normal web pages; close/disable it on Home and other non-pages. */
export async function syncSidePanelForTab(tab: {
  id?: number;
  url?: string;
  windowId?: number;
  incognito?: boolean;
}): Promise<void> {
  if (typeof tab.id !== "number") return;
  // Without a known URL, do not disable — an early disable blocks sidePanel.open from Home.
  if (!tab.url) return;

  const allow = !tab.incognito && !isHomeUrl(tab.url) && isEligibleUrl(tab.url);
  if (allow) {
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: "sidepanel.html",
      enabled: true,
    });
    return;
  }
  await chrome.sidePanel.setOptions({ tabId: tab.id, enabled: false });
  await closePanelForTab({ id: tab.id, windowId: tab.windowId });
}

/** Register tab listeners so panel availability tracks the active page. */
export function installSidePanelGate(): void {
  const sync = (tab: chrome.tabs.Tab) => {
    syncSidePanelForTab(tab).catch((error) =>
      console.warn("[ai-browser] side panel gate failed", error),
    );
  };

  chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
    if (info.status === "complete" || info.url !== undefined) sync(tab);
  });
  chrome.tabs.onActivated.addListener((info) => {
    chrome.tabs.get(info.tabId).then(sync).catch(() => undefined);
  });
  chrome.tabs.query({}).then((tabs) => tabs.forEach(sync)).catch(() => undefined);
}
