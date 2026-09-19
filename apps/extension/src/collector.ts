// Turns Chrome tab events into queued events and pending snapshots. It only
// observes: it never moves, groups, renames, or closes a tab, and it never
// decides whether two tabs are "the same" (the backend does that).
//
// A tab is *tracked* once it has been seen on an eligible page (http/https in a
// normal window); tracked tabs are the keys of the store's mirror. Opens,
// closes, and activations are reported immediately. Other changes wait
// until the tab has been quiet for SETTLE_MS, or for MAX_DELAY_MS after the
// first change if it never goes quiet, then one `updated` carries the final
// state. See specs/002-tab-ingestion-extension/data-model.md.
import type { TabEventInput, TabSnapshotInput } from "@ai-browser/shared";
import { clampUrl, isEligibleTab, type TabLike } from "./filters";
import { captureSnippet, resolveSnippet } from "./snippet";
import type { MirrorEntry, Store } from "./store";

export const SETTLE_MS = 2000;
export const MAX_DELAY_MS = 30_000;

export interface CollectorDeps {
  store: Store;
  now?: () => number;
  uuid?: () => string;
  /** Called after anything is queued for delivery, so the sender can run soon. */
  onQueued?: () => void;
  getTab?: (tabId: number) => Promise<TabLike | undefined>;
  /** Reads a page's text; injectable for tests. */
  captureSnippet?: (tabId: number) => Promise<string>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  settleMs?: number;
  maxDelayMs?: number;
}

export interface TabChangeInfo {
  url?: string;
  title?: string;
  status?: string;
}

export function createCollector(deps: CollectorDeps) {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  const onQueued = deps.onQueued ?? (() => undefined);
  const settleMs = deps.settleMs ?? SETTLE_MS;
  const maxDelayMs = deps.maxDelayMs ?? MAX_DELAY_MS;
  const getTab =
    deps.getTab ??
    (async (tabId: number) => {
      try {
        return (await chrome.tabs.get(tabId)) as TabLike;
      } catch {
        return undefined; // the tab is gone
      }
    });
  const capture = deps.captureSnippet ?? captureSnippet;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  // In-memory only, and only to fire flushes promptly. The persisted pending
  // state is what survives a worker restart; flushDue() picks it up.
  const timers = new Map<number, unknown>();
  const waitStarted = new Map<number, number>();

  // Handlers for the same tab run one after another. Chrome fires events close
  // together, and the settle timer and the heartbeat can flush the same tab at
  // the same moment; without this each would read "not tracked yet" and report
  // the tab as opened twice.
  const chains = new Map<number, Promise<unknown>>();
  function exclusive<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
    const previous = chains.get(tabId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    chains.set(tabId, tail);
    void tail.then(() => {
      if (chains.get(tabId) === tail) chains.delete(tabId);
    });
    return run;
  }

  const iso = (ms: number) => new Date(ms).toISOString();

  const makeEvent = (
    eventType: TabEventInput["eventType"],
    chromeTabId: number,
    url: string,
    title: string,
    atMs: number,
  ): TabEventInput => ({ id: uuid(), time: iso(atMs), chromeTabId, url, title, eventType });

  const snapshotOf = (tabId: number, tab: TabLike, atMs: number, snippet = ""): TabSnapshotInput => ({
    chromeTabId: tabId,
    windowId: tab.windowId,
    active: Boolean(tab.active),
    url: clampUrl(tab.url ?? ""),
    title: tab.title ?? "",
    snippet,
    lastSeenAt: iso(atMs),
  });

  const mirrorOf = (tab: TabLike, atMs: number): MirrorEntry => ({
    url: clampUrl(tab.url ?? ""),
    title: tab.title ?? "",
    windowId: tab.windowId,
    lastSeenAt: iso(atMs),
  });

  function cancel(tabId: number) {
    const handle = timers.get(tabId);
    if (handle !== undefined) clearTimer(handle);
    timers.delete(tabId);
    waitStarted.delete(tabId);
  }

  function schedule(tabId: number) {
    const t = now();
    const started = waitStarted.get(tabId) ?? t;
    waitStarted.set(tabId, started);
    const untilCap = Math.max(0, started + maxDelayMs - t);
    const existing = timers.get(tabId);
    if (existing !== undefined) clearTimer(existing);
    timers.set(
      tabId,
      setTimer(() => void flushTab(tabId), Math.min(settleMs, untilCap)),
    );
  }

  /** Records that a tab changed and will be reported once it settles. */
  async function markPending(tabId: number, tab: TabLike) {
    await store.apply({ dirty: [{ tabId, snapshot: snapshotOf(tabId, tab, now()), ready: false }] });
    schedule(tabId);
  }

  /** The tab stopped being reportable (closed, or moved to an internal page). */
  async function endTracking(tabId: number, tracked: MirrorEntry) {
    cancel(tabId);
    await store.apply({
      events: [makeEvent("closed", tabId, tracked.url, tracked.title, now())],
      mirror: { [tabId]: null },
      dropDirty: [tabId],
      snippets: { [tabId]: null },
    });
    onQueued();
  }

  /**
   * Reports a settled tab: an opened/updated event if something changed, and a
   * fresh snapshot. Does nothing if the tab has no unsent change (it was already
   * flushed, or there was never one), so a second trigger is harmless.
   */
  function flushTab(tabId: number): Promise<void> {
    return exclusive(tabId, () => flushLocked(tabId));
  }

  async function flushLocked(tabId: number) {
    cancel(tabId);
    const pending = (await store.listDirty()).find((d) => d.tabId === tabId)?.entry;
    if (!pending || pending.ready) return;
    const tab = await getTab(tabId);
    const tracked = (await store.getMirror()).get(tabId);

    if (!tab || !isEligibleTab(tab)) {
      if (tracked) await endTracking(tabId, tracked);
      else await store.apply({ dropDirty: [tabId] });
      return;
    }

    const t = now();
    const url = clampUrl(tab.url ?? "");
    const title = tab.title ?? "";
    const changedAt = pending.lastChangeAt;
    const events: TabEventInput[] = [];
    if (!tracked) events.push(makeEvent("opened", tabId, url, title, changedAt));
    else if (tracked.url !== url || tracked.title !== title) {
      events.push(makeEvent("updated", tabId, url, title, changedAt));
    }

    // The snippet goes only into the snapshot, never into an event.
    const snippet = await resolveSnippet({ store, capture }, tab, tabId, url);
    await store.apply({
      events,
      dirty: [{ tabId, snapshot: snapshotOf(tabId, tab, t, snippet.text), ready: true }],
      mirror: { [tabId]: mirrorOf(tab, t) },
      ...(snippet.cache ? { snippets: { [tabId]: snippet.cache } } : {}),
    });
    onQueued();
  }

  /** Flushes every pending tab that is due: quiet for the settle time, or waiting longer than the cap. */
  async function flushDue(): Promise<number> {
    const t = now();
    const due = (await store.listDirty()).filter(
      ({ entry }) => !entry.ready && (t - entry.lastChangeAt >= settleMs || t - entry.firstDirtyAt >= maxDelayMs),
    );
    for (const { tabId } of due) await flushTab(tabId);
    return due.length;
  }

  function onTabCreated(tab: TabLike): Promise<void> {
    const tabId = tab.id;
    if (tabId === undefined || !isEligibleTab(tab)) return Promise.resolve();
    return exclusive(tabId, async () => {
      if ((await store.getMirror()).has(tabId)) return;

      const t = now();
      const entry = mirrorOf(tab, t);
      await store.apply({
        events: [makeEvent("opened", tabId, entry.url, entry.title, t)],
        mirror: { [tabId]: entry },
        dirty: [{ tabId, snapshot: snapshotOf(tabId, tab, t), ready: false }],
      });
      schedule(tabId);
      onQueued();
    });
  }

  function onTabUpdated(tabId: number, changeInfo: TabChangeInfo, tab: TabLike): Promise<void> {
    if (changeInfo.url === undefined && changeInfo.title === undefined && changeInfo.status !== "complete") {
      return Promise.resolve();
    }
    return exclusive(tabId, async () => {
      const tracked = (await store.getMirror()).get(tabId);
      if (!isEligibleTab(tab)) {
        // Moved to an internal page: stop tracking without ever reporting where it went.
        if (tracked) await endTracking(tabId, tracked);
        return;
      }
      await markPending(tabId, tab);
    });
  }

  function onTabRemoved(tabId: number): Promise<void> {
    return exclusive(tabId, async () => {
      const tracked = (await store.getMirror()).get(tabId);
      if (tracked) {
        await endTracking(tabId, tracked);
      } else {
        cancel(tabId);
        await store.apply({ dropDirty: [tabId] });
      }
    });
  }

  /**
   * A tab id was swapped for another (for example by prerendering). The new id
   * is one the backend has never seen, so this is the old id closing and the
   * new id opening; whether they are the same tab is the backend's call.
   */
  async function onTabReplaced(addedTabId: number, removedTabId: number) {
    await onTabRemoved(removedTabId);
    const tab = await getTab(addedTabId);
    if (tab && isEligibleTab(tab)) await exclusive(addedTabId, () => markPending(addedTabId, tab));
  }

  /** A tracked tab became the active one: reported immediately, without the settle wait. */
  function reportActivated(tabId: number): Promise<void> {
    return exclusive(tabId, async () => {
      const tracked = (await store.getMirror()).get(tabId);
      if (!tracked) return; // not a reportable page: nothing to say about it
      await store.apply({ events: [makeEvent("activated", tabId, tracked.url, tracked.title, now())] });
      onQueued();
    });
  }

  async function onTabActivated(info: { tabId: number; windowId: number }) {
    await reportActivated(info.tabId);
  }

  /** A window gained focus: its active tab is now the one in front. */
  async function onWindowFocusChanged(windowId: number) {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    const [tab] = (await chrome.tabs.query({ active: true, windowId })) as TabLike[];
    if (tab?.id !== undefined && isEligibleTab(tab)) await reportActivated(tab.id);
  }

  return {
    onTabCreated,
    onTabUpdated,
    onTabRemoved,
    onTabReplaced,
    onTabActivated,
    onWindowFocusChanged,
    flushTab,
    flushDue,
  };
}

export type Collector = ReturnType<typeof createCollector>;
