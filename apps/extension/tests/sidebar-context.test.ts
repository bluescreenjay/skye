import { afterEach, describe, expect, it, vi } from "vitest";
import type { PanelView } from "../src/sidebar/state";
import { createSidebarContext } from "../src/sidebar/context";

function event<T extends (...args: never[]) => void>() {
  const listeners = new Set<T>();
  return {
    addListener: (listener: T) => { listeners.add(listener); },
    removeListener: (listener: T) => { listeners.delete(listener); },
    fire: (...args: Parameters<T>) => { for (const listener of listeners) listener(...args); },
    count: () => listeners.size,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function browserMock() {
  type TestTab = { id: number; windowId: number; active: boolean; url: string; incognito: boolean };
  let tab: TestTab = { id: 1, windowId: 2, active: true, url: "https://example.com/a", incognito: false };
  const onActivated = event<(info: { tabId: number; windowId: number }) => void>();
  const onUpdated = event<(tabId: number, change: { url?: string }, tab: TestTab) => void>();
  const onRemoved = event<(tabId: number, info: { windowId: number; isWindowClosing: boolean }) => void>();
  const onReplaced = event<(added: number, removed: number) => void>();
  const onFocusChanged = event<(windowId: number) => void>();
  vi.stubGlobal("chrome", {
    tabs: {
      query: vi.fn(async () => [tab]),
      onActivated, onUpdated, onRemoved, onReplaced,
    },
    windows: { onFocusChanged, WINDOW_ID_NONE: -1 },
  });
  return {
    setTab: (next: TestTab) => { tab = next; },
    onActivated, onUpdated, onRemoved, onReplaced, onFocusChanged,
  };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
afterEach(() => vi.unstubAllGlobals());

describe("createSidebarContext", () => {
  it("never commits an older page after a rapid switch", async () => {
    const browser = browserMock();
    const first = deferred<PanelView>();
    const second = deferred<PanelView>();
    const load = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const views: PanelView[] = [];
    const stop = createSidebarContext(2, load, (view) => views.push(view));
    await flush();

    browser.setTab({ id: 2, windowId: 2, active: true, url: "https://example.com/b", incognito: false });
    browser.onActivated.fire({ tabId: 2, windowId: 2 });
    await flush();
    second.resolve({ kind: "other", page: { tabId: 2, windowId: 2, url: "https://example.com/b" }, tabs: [], tabRef: null });
    await flush();
    first.resolve({ kind: "other", page: { tabId: 1, windowId: 2, url: "https://example.com/a" }, tabs: [], tabRef: null });
    await flush();

    expect(views.at(-1)).toMatchObject({ kind: "other", page: { tabId: 2 } });
    stop();
    expect(browser.onActivated.count()).toBe(0);
  });

  it("ignores other windows and refreshes on active URL, removal, and replacement", async () => {
    const browser = browserMock();
    const load = vi.fn(async (page) => ({ kind: "other", page, tabs: [], tabRef: null } as PanelView));
    const views: PanelView[] = [];
    const stop = createSidebarContext(2, load, (view) => views.push(view));
    await flush();
    const initial = load.mock.calls.length;
    browser.onActivated.fire({ tabId: 99, windowId: 9 });
    browser.onFocusChanged.fire(9);
    await flush();
    expect(load).toHaveBeenCalledTimes(initial);

    const updated = { id: 1, windowId: 2, active: true, url: "https://example.com/new", incognito: false };
    browser.setTab(updated);
    browser.onUpdated.fire(1, { url: updated.url }, updated);
    await flush();
    expect(views.at(-1)).toMatchObject({ kind: "other", page: { url: updated.url } });
    browser.onRemoved.fire(1, { windowId: 2, isWindowClosing: false });
    await flush();
    browser.onReplaced.fire(3, 1);
    await flush();
    expect(load.mock.calls.length).toBeGreaterThan(initial + 1);
    stop();
  });

  it("keeps the newest page through 20 switches and clears on an ineligible page", async () => {
    const browser = browserMock();
    const pending: Array<{ page: { tabId: number; windowId: number; url: string }; result: ReturnType<typeof deferred<PanelView>> }> = [];
    const load = vi.fn((page) => {
      const result = deferred<PanelView>();
      pending.push({ page, result });
      return result.promise;
    });
    const views: PanelView[] = [];
    const stop = createSidebarContext(2, load, (view) => views.push(view));
    await flush();

    for (let id = 2; id <= 21; id += 1) {
      browser.setTab({ id, windowId: 2, active: true, url: `https://example.com/${id}`, incognito: false });
      browser.onActivated.fire({ tabId: id, windowId: 2 });
      await flush();
    }
    expect(pending).toHaveLength(21);
    pending.at(-1)!.result.resolve({ kind: "other", page: pending.at(-1)!.page, tabs: [], tabRef: null });
    await flush();
    for (const item of pending.slice(0, -1).reverse()) {
      item.result.resolve({ kind: "other", page: item.page, tabs: [], tabRef: null });
    }
    await flush();
    expect(views.at(-1)).toMatchObject({ kind: "other", page: { tabId: 21 } });

    browser.setTab({ id: 22, windowId: 2, active: true, url: "chrome://extensions", incognito: false });
    browser.onActivated.fire({ tabId: 22, windowId: 2 });
    await flush();
    expect(views.at(-1)?.kind).toBe("ineligible");
    stop();
  });

  it("re-reads saved context after stopping and reopening", async () => {
    browserMock();
    const load = vi.fn(async (page) => ({ kind: "other", page, tabs: [], tabRef: null } as PanelView));
    const first: PanelView[] = [];
    const stopFirst = createSidebarContext(2, load, (view) => first.push(view));
    await flush();
    stopFirst();

    const reopened: PanelView[] = [];
    const stopSecond = createSidebarContext(2, load, (view) => reopened.push(view));
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(reopened.at(-1)).toMatchObject({ kind: "other", page: { tabId: 1 } });
    stopSecond();
  });
});
