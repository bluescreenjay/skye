// Full snapshots: compare every tab Chrome reports against what we last
// reported (the mirror), queue the differences as events, and queue a ready
// snapshot for every eligible tab. Used at install, browser start, and after a
// gap in delivery, so the backend's view can be reconciled with the browser.
import type { IngestActiveTab, TabEventInput, TabSnapshotInput } from "@ai-browser/shared";
import { clampUrl, isEligibleTab, type TabLike } from "./filters";
import { captureSnippet, mapLimit, resolveSnippet, SNIPPET_CONCURRENCY } from "./snippet";
import type { MirrorEntry, SnippetCacheEntry, Store } from "./store";

export interface SnapshotterDeps {
  store: Store;
  now?: () => number;
  uuid?: () => string;
  onQueued?: () => void;
  /** Reads a page's text; injectable for tests. */
  captureSnippet?: (tabId: number) => Promise<string>;
}

export function createSnapshotter(deps: SnapshotterDeps) {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  const onQueued = deps.onQueued ?? (() => undefined);
  const capture = deps.captureSnippet ?? captureSnippet;

  const iso = (ms: number) => new Date(ms).toISOString();
  const makeEvent = (
    eventType: TabEventInput["eventType"],
    chromeTabId: number,
    url: string,
    title: string,
    time: string,
  ): TabEventInput => ({ id: uuid(), time, chromeTabId, url, title, eventType });

  /**
   * Brings the store in line with `tabs` (the complete list of open tabs):
   * new eligible tabs open, vanished ones close, changed ones update, and every
   * eligible tab gets a ready snapshot.
   */
  async function reconcile(tabs: TabLike[]): Promise<void> {
    const t = now();
    const time = iso(t);
    const eligible = tabs.filter((tab): tab is TabLike & { id: number } => tab.id !== undefined && isEligibleTab(tab));
    const eligibleIds = new Set(eligible.map((tab) => tab.id));
    const mirror = await store.getMirror();

    // Read the pages first, a few at a time, so 100 tabs finish quickly.
    const snippets = await mapLimit(eligible, SNIPPET_CONCURRENCY, (tab) =>
      resolveSnippet({ store, capture }, tab, tab.id, clampUrl(tab.url ?? "")),
    );

    const events: TabEventInput[] = [];
    const dirty: { tabId: number; snapshot: TabSnapshotInput; ready: boolean }[] = [];
    const mirrorChanges: Record<number, MirrorEntry | null> = {};
    const snippetChanges: Record<number, SnippetCacheEntry | null> = {};
    const dropDirty: number[] = [];

    for (const [index, tab] of eligible.entries()) {
      const url = clampUrl(tab.url ?? "");
      const title = tab.title ?? "";
      const snippet = snippets[index];
      if (snippet.cache) snippetChanges[tab.id] = snippet.cache;
      const previous = mirror.get(tab.id);
      if (!previous) events.push(makeEvent("opened", tab.id, url, title, time));
      else if (previous.url !== url || previous.title !== title) {
        events.push(makeEvent("updated", tab.id, url, title, time));
      }
      mirrorChanges[tab.id] = { url, title, windowId: tab.windowId, lastSeenAt: time };
      dirty.push({
        tabId: tab.id,
        ready: true,
        snapshot: {
          chromeTabId: tab.id,
          windowId: tab.windowId,
          active: Boolean(tab.active),
          url,
          title,
          snippet: snippet.text,
          lastSeenAt: time,
        },
      });
    }

    for (const [tabId, previous] of mirror) {
      if (eligibleIds.has(tabId)) continue;
      events.push(makeEvent("closed", tabId, previous.url, previous.title, time));
      mirrorChanges[tabId] = null;
      snippetChanges[tabId] = null;
    }
    // Pending snapshots for tabs that no longer exist are never reported.
    for (const { tabId } of await store.listDirty()) {
      if (!eligibleIds.has(tabId)) dropDirty.push(tabId);
    }

    await store.apply({ events, dirty, dropDirty, mirror: mirrorChanges, snippets: snippetChanges });
    if (events.length > 0 || dirty.length > 0) onQueued();
  }

  /** Asks Chrome for every open tab and reconciles. */
  async function takeFullSnapshot(): Promise<void> {
    await reconcile((await chrome.tabs.query({})) as TabLike[]);
  }

  /**
   * Tab ids from an earlier browser session cannot be trusted (Chrome may reuse
   * them for different tabs), so on browser start every remembered tab is
   * closed out at the time it was last seen and the mirror is cleared. The full
   * snapshot that follows reports whatever the browser restored as newly opened.
   */
  async function resetForBrowserStart(): Promise<void> {
    const mirror = await store.getMirror();
    const pending = await store.listDirty();
    if (mirror.size === 0 && pending.length === 0) return;

    const events: TabEventInput[] = [];
    const mirrorChanges: Record<number, MirrorEntry | null> = {};
    const snippetChanges: Record<number, SnippetCacheEntry | null> = {};
    for (const [tabId, previous] of mirror) {
      events.push(makeEvent("closed", tabId, previous.url, previous.title, previous.lastSeenAt));
      mirrorChanges[tabId] = null;
      snippetChanges[tabId] = null;
    }
    await store.apply({
      events,
      mirror: mirrorChanges,
      snippets: snippetChanges,
      dropDirty: pending.map((d) => d.tabId),
    });
    if (events.length > 0) onQueued();
  }

  /**
   * The focused window and its active tab, sampled when a request is built. The
   * tab id is null when the active tab is not one we report (an internal page),
   * which is how the backend learns the previous tab is no longer in front.
   * An incognito window is never named.
   */
  async function sampleActive(): Promise<IngestActiveTab> {
    const none: IngestActiveTab = { windowId: null, chromeTabId: null };
    const win = await chrome.windows.getLastFocused();
    if (win.id === undefined || win.id === chrome.windows.WINDOW_ID_NONE || win.incognito) return none;

    const [tab] = (await chrome.tabs.query({ active: true, windowId: win.id })) as TabLike[];
    const tabId = tab?.id;
    const reportable = tabId !== undefined && isEligibleTab(tab) && (await store.getMirror()).has(tabId);
    return { windowId: win.id, chromeTabId: reportable ? tabId : null };
  }

  return { reconcile, takeFullSnapshot, resetForBrowserStart, sampleActive };
}

export type Snapshotter = ReturnType<typeof createSnapshotter>;
