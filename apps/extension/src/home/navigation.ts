import type { TabRef } from "@ai-browser/shared";
import { syncSidePanelForTab } from "../sidepanel-gate";

function openNewTab(url: string): void {
  try {
    void chrome.tabs.create({ url });
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

/**
 * Focus a live matching browser tab, or open the saved URL in a new tab.
 * Does not touch the Side Panel — callers that need the panel open do that separately.
 */
export async function focusOrOpenSavedTab(tab: TabRef): Promise<"focused" | "opened"> {
  if (tab.chromeTabId === null) {
    openNewTab(tab.url);
    return "opened";
  }

  try {
    const liveTab = await chrome.tabs.get(tab.chromeTabId);
    if (liveTab.url !== tab.url || liveTab.incognito || liveTab.windowId === undefined) {
      openNewTab(tab.url);
      return "opened";
    }

    await chrome.windows.update(liveTab.windowId, { focused: true });
    await chrome.tabs.update(tab.chromeTabId, { active: true });
    return "focused";
  } catch {
    openNewTab(tab.url);
    return "opened";
  }
}

/** Focus a saved live tab from Home and bring its workspace into the Side Panel. */
export async function openHomeTab(tab: TabRef): Promise<void> {
  if (tab.chromeTabId === null) {
    openNewTab(tab.url);
    return;
  }

  try {
    const liveTab = await chrome.tabs.get(tab.chromeTabId);
    if (liveTab.url !== tab.url || liveTab.incognito || liveTab.windowId === undefined) {
      openNewTab(tab.url);
      return;
    }

    await chrome.windows.update(liveTab.windowId, { focused: true });
    await chrome.tabs.update(tab.chromeTabId, { active: true });
    // Gate may have left this tab disabled while Home was active — re-enable before open.
    await syncSidePanelForTab(liveTab);
    try {
      await chrome.sidePanel.open({ tabId: tab.chromeTabId });
    } catch (error) {
      // Focus already succeeded; do not open a duplicate tab if only the panel failed.
      console.warn("[ai-browser] could not open Side Panel", error);
    }
  } catch {
    openNewTab(tab.url);
  }
}
