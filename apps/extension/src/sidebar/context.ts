import { isEligibleTab } from "../filters";
import type { ActivePage, PanelView } from "./state";

export type PageSelection =
  | { kind: "eligible"; page: ActivePage }
  | { kind: "ineligible" }
  | { kind: "unavailable"; message: string };

/** This panel instance belongs to one browser window, not whichever window was last focused. */
export async function getPanelWindowId(): Promise<number | null> {
  try {
    const window = await chrome.windows.getCurrent();
    return window.type === "normal" && !window.incognito && typeof window.id === "number"
      ? window.id
      : null;
  } catch {
    return null;
  }
}

export async function readActivePage(windowId: number): Promise<PageSelection> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (!tab || typeof tab.id !== "number" || !isEligibleTab(tab)) {
      return { kind: "ineligible" };
    }
    return { kind: "eligible", page: { tabId: tab.id, windowId, url: tab.url! } };
  } catch {
    return { kind: "unavailable", message: "could not read the active page" };
  }
}

/**
 * A panel instance follows only its containing window. Every refresh supersedes
 * the last one, including while Chrome or the API is still resolving it.
 */
export function createSidebarContext(
  windowId: number,
  load: (page: ActivePage, signal: AbortSignal) => Promise<PanelView>,
  emit: (view: PanelView) => void,
): () => void {
  let generation = 0;
  let stopped = false;
  let controller: AbortController | null = null;
  let currentTabId: number | null = null;

  const refresh = () => {
    const request = ++generation;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    emit({ kind: "loading" });
    void (async () => {
      const selection = await readActivePage(windowId);
      if (stopped || request !== generation) return;
      if (selection.kind === "unavailable") {
        currentTabId = null;
        emit(selection);
        return;
      }
      if (selection.kind === "ineligible") {
        currentTabId = null;
        emit({ kind: "ineligible" });
        return;
      }
      currentTabId = selection.page.tabId;
      const view = await load(selection.page, signal);
      if (!stopped && request === generation && !signal.aborted) emit(view);
    })().catch(() => {
      if (!stopped && request === generation && !signal.aborted) {
        emit({ kind: "unavailable", message: "workspace unavailable" });
      }
    });
  };

  const onActivated: Parameters<typeof chrome.tabs.onActivated.addListener>[0] = (info) => {
    if (info.windowId === windowId) refresh();
  };
  const onUpdated: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] = (tabId, changes, tab) => {
    if (tab.windowId === windowId && tab.active && (changes.url !== undefined || changes.status === "complete")) {
      refresh();
    }
  };
  const onRemoved: Parameters<typeof chrome.tabs.onRemoved.addListener>[0] = (tabId, info) => {
    if (info.windowId === windowId && tabId === currentTabId) refresh();
  };
  const onReplaced: Parameters<typeof chrome.tabs.onReplaced.addListener>[0] = (_added, removed) => {
    if (removed === currentTabId) refresh();
  };
  const onFocusChanged: Parameters<typeof chrome.windows.onFocusChanged.addListener>[0] = (focused) => {
    if (focused === windowId) refresh();
  };

  chrome.tabs.onActivated.addListener(onActivated);
  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.tabs.onRemoved.addListener(onRemoved);
  chrome.tabs.onReplaced.addListener(onReplaced);
  chrome.windows.onFocusChanged.addListener(onFocusChanged);
  refresh();

  return () => {
    stopped = true;
    generation += 1;
    controller?.abort();
    chrome.tabs.onActivated.removeListener(onActivated);
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.onRemoved.removeListener(onRemoved);
    chrome.tabs.onReplaced.removeListener(onReplaced);
    chrome.windows.onFocusChanged.removeListener(onFocusChanged);
  };
}
