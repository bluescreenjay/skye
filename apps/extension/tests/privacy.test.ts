import type { IngestBatchRequest } from "@ai-browser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollector } from "../src/collector";
import { createSender } from "../src/sender";
import { createSnapshotter } from "../src/snapshot";
import { createStore, type Store } from "../src/store";
import { installChromeMock, type ChromeMock, type MockTab } from "./helpers/chrome-mock";

// The single cross-module privacy check (FR-013, SC-005). filters.test.ts unit-tests
// the rule; this runs incognito tabs and internal pages through the whole pipeline
// and searches everything that was stored or sent for any trace of them.

const T0 = Date.parse("2026-09-19T10:00:00.000Z");
const cfg = { ok: true, config: { apiBaseUrl: "http://localhost:8787", deviceToken: "tok" } } as const;

const SECRETS = [
  "secret-incognito-bank",
  "SECRET INCOGNITO TITLE",
  "chrome://settings/passwords",
  "chrome-extension://abcdef/secret.html",
  "file:///etc/secret-file.txt",
  "view-source:https://example.com/secret-source",
  "about:secret-blank",
];

let mock: ChromeMock;
let store: Store;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  mock = installChromeMock();
  store = createStore({ now: () => Date.now() });
  fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ accepted: 0, duplicates: 0 }), { status: 200 }));
});
afterEach(() => vi.useRealTimers());

const web = (id: number, over: Partial<MockTab> = {}): MockTab => ({
  id,
  windowId: 1,
  url: `https://example.com/${id}`,
  title: `Public page ${id}`,
  active: id === 1,
  ...over,
});

const hidden = (): MockTab[] => [
  { id: 101, windowId: 2, url: "https://bank.example/secret-incognito-bank", title: "SECRET INCOGNITO TITLE", incognito: true, active: true },
  { id: 102, windowId: 1, url: "chrome://settings/passwords", title: "Passwords" },
  { id: 103, windowId: 1, url: "chrome-extension://abcdef/secret.html", title: "Extension page" },
  { id: 104, windowId: 1, url: "file:///etc/secret-file.txt", title: "A local file" },
  { id: 105, windowId: 1, url: "view-source:https://example.com/secret-source", title: "Source" },
  { id: 106, windowId: 1, url: "about:secret-blank", title: "Blank" },
];

const everythingStoredOrSent = () =>
  JSON.stringify([[...mock.storage.entries()], fetchMock.mock.calls.map((c) => c[1]?.body ?? "")]);

describe("nothing from incognito windows or internal pages is ever read, stored, or sent", () => {
  it("through a full snapshot and a delivery", async () => {
    mock.tabs = [web(1), web(2), ...hidden()];
    for (const t of hidden()) mock.scriptResults.set(t.id, "secret page text SECRET-BODY");
    const snapshotter = createSnapshotter({ store, now: () => Date.now() });
    const sender = createSender({
      store,
      getConfig: () => cfg,
      fetchFn: fetchMock,
      now: () => Date.now(),
      takeFullSnapshot: () => snapshotter.takeFullSnapshot(),
      sampleActive: () => snapshotter.sampleActive(),
    });
    await store.updateState({ needsFullSnapshot: true });
    await sender.drainOnce();

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string) as IngestBatchRequest;
    expect(body.tabs.map((t) => t.chromeTabId).sort()).toEqual([1, 2]);
    expect(body.events.map((e) => e.chromeTabId).sort()).toEqual([1, 2]);
    const text = everythingStoredOrSent();
    for (const secret of [...SECRETS, "SECRET-BODY"]) expect(text).not.toContain(secret);
    expect(mock.scriptCalls.filter((id) => id >= 100)).toEqual([]); // their pages were never read
  });

  it("through live tab events of every kind", async () => {
    const collector = createCollector({ store, now: () => Date.now() });
    mock.tabs = [web(1), ...hidden()];
    for (const t of hidden()) mock.scriptResults.set(t.id, "secret page text SECRET-BODY");

    for (const t of hidden()) {
      await collector.onTabCreated(t);
      await collector.onTabUpdated(t.id, { url: t.url, title: t.title, status: "complete" }, t);
      await collector.onTabActivated({ tabId: t.id, windowId: t.windowId });
      await collector.onTabRemoved(t.id);
    }
    await collector.onWindowFocusChanged(2); // the incognito window gains focus
    await vi.advanceTimersByTimeAsync(60_000);
    await collector.flushDue();

    expect((await store.readBatch(100)).events).toEqual([]);
    expect(await store.listDirty()).toEqual([]);
    expect((await store.getMirror()).size).toBe(0);
    const text = everythingStoredOrSent();
    for (const secret of [...SECRETS, "SECRET-BODY"]) expect(text).not.toContain(secret);
    expect(mock.scriptCalls).toEqual([]);
  });

  it("when a normal tab goes to an internal page: it closes, and the new address is never recorded", async () => {
    const collector = createCollector({ store, now: () => Date.now() });
    const tab = web(1);
    mock.tabs = [tab];
    await collector.onTabCreated(tab);
    await vi.advanceTimersByTimeAsync(2000);

    for (const url of ["chrome://settings/passwords", "file:///etc/secret-file.txt", "view-source:https://example.com/secret-source"]) {
      const next = web(1, { url, title: "SECRET INCOGNITO TITLE" });
      mock.tabs = [next];
      await collector.onTabUpdated(1, { url, title: next.title }, next);
      await vi.advanceTimersByTimeAsync(5000);
    }
    const text = everythingStoredOrSent();
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });

  it("the active-tab sample never names an incognito window, and reports null for an internal page", async () => {
    const snapshotter = createSnapshotter({ store, now: () => Date.now() });
    mock.tabs = [web(1), ...hidden()];
    await snapshotter.reconcile(mock.tabs);

    mock.focusedWindowId = 2; // the incognito window
    expect(await snapshotter.sampleActive()).toEqual({ windowId: null, chromeTabId: null });

    mock.focusedWindowId = 1;
    mock.tabs = [web(1, { active: false }), { ...hidden()[1], active: true }]; // the front tab is chrome://settings
    expect(await snapshotter.sampleActive()).toEqual({ windowId: 1, chromeTabId: null });
  });

  it("a tab that was reported and then moved to an incognito-like state is dropped from later snapshots", async () => {
    const snapshotter = createSnapshotter({ store, now: () => Date.now() });
    mock.tabs = [web(1), web(2)];
    await snapshotter.takeFullSnapshot();
    mock.tabs = [web(1), web(2, { incognito: true })];
    await snapshotter.takeFullSnapshot();
    const kinds = (await store.readBatch(100)).events.map((e) => `${e.event.eventType}:${e.event.chromeTabId}`);
    expect(kinds).toEqual(["opened:1", "opened:2", "closed:2"]);
  });
});
