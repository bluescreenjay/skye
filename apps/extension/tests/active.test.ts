import type { IngestBatchRequest } from "@ai-browser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollector } from "../src/collector";
import { createSender } from "../src/sender";
import { createSnapshotter } from "../src/snapshot";
import { createStore, type Store } from "../src/store";
import { installChromeMock, type ChromeMock, type MockTab } from "./helpers/chrome-mock";

const T0 = Date.parse("2026-09-19T10:00:00.000Z");

let mock: ChromeMock;
let store: Store;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  mock = installChromeMock();
  store = createStore({ now: () => Date.now() });
});

afterEach(() => {
  vi.useRealTimers();
});

const collector = () => createCollector({ store, now: () => Date.now() });
const snapshotter = () => createSnapshotter({ store, now: () => Date.now() });
const events = async () => (await store.readBatch(1000)).events.map((e) => e.event);
const kinds = async () => (await events()).map((e) => `${e.eventType}:${e.chromeTabId}`);

const page = (id: number, over: Partial<MockTab> = {}): MockTab => ({
  id,
  windowId: 1,
  url: `https://example.com/${id}`,
  title: `Page ${id}`,
  active: false,
  ...over,
});

/** Puts tabs in the browser and reports them, so each one is tracked. */
async function openTabs(...tabs: MockTab[]) {
  mock.tabs = tabs;
  await snapshotter().reconcile(tabs);
}

describe("activation events", () => {
  it("reports a tracked tab becoming active immediately, with its last reported address and title", async () => {
    await openTabs(page(1, { active: true }), page(2));
    const c = collector();
    await c.onTabActivated({ tabId: 2, windowId: 1 });

    const last = (await events()).at(-1)!;
    expect(last).toMatchObject({ eventType: "activated", chromeTabId: 2, url: "https://example.com/2", title: "Page 2" });
    expect(last.time).toBe(new Date(T0).toISOString());
  });

  it("reports nothing when the tab that became active is not reportable", async () => {
    await openTabs(page(1, { active: true }), page(2, { url: "chrome://settings" }));
    await collector().onTabActivated({ tabId: 2, windowId: 1 });
    expect(await kinds()).toEqual(["opened:1"]);
  });

  it("reports the active tab of a window when that window gains focus", async () => {
    await openTabs(
      page(1, { windowId: 1, active: true }),
      page(2, { windowId: 2, active: true }),
      page(3, { windowId: 2 }),
    );
    await collector().onWindowFocusChanged(2);
    const last = (await events()).at(-1)!;
    expect(last).toMatchObject({ eventType: "activated", chromeTabId: 2 });
  });

  it("ignores a focus change to 'no window'", async () => {
    await openTabs(page(1, { active: true }));
    await collector().onWindowFocusChanged(-1);
    expect(await kinds()).toEqual(["opened:1"]);
  });

  it("reports nothing when the newly focused window's active tab is not reportable", async () => {
    await openTabs(page(1, { active: true }), page(2, { windowId: 2, active: true, incognito: true }));
    await collector().onWindowFocusChanged(2);
    expect(await kinds()).toEqual(["opened:1"]);
  });

  it("follows a closed active tab with the activation of the tab that comes forward", async () => {
    await openTabs(page(1, { active: true }), page(2));
    const c = collector();
    await c.onTabRemoved(1);
    mock.tabs = [page(2, { active: true })];
    await c.onTabActivated({ tabId: 2, windowId: 1 });
    expect(await kinds()).toEqual(["opened:1", "opened:2", "closed:1", "activated:2"]);
  });

  it("queues activation events in order, each with its own id", async () => {
    await openTabs(page(1, { active: true }), page(2));
    const c = collector();
    await c.onTabActivated({ tabId: 2, windowId: 1 });
    await c.onTabActivated({ tabId: 1, windowId: 1 });
    const acts = (await events()).filter((e) => e.eventType === "activated");
    expect(acts.map((e) => e.chromeTabId)).toEqual([2, 1]);
    expect(new Set(acts.map((e) => e.id)).size).toBe(2);
  });
});

describe("sampleActive", () => {
  it("names the focused window and its active tab when that tab is tracked", async () => {
    await openTabs(page(1, { active: true }), page(2));
    expect(await snapshotter().sampleActive()).toEqual({ windowId: 1, chromeTabId: 1 });
  });

  it("follows the focused window", async () => {
    await openTabs(page(1, { windowId: 1, active: true }), page(2, { windowId: 2, active: true }));
    mock.focusedWindowId = 2;
    expect(await snapshotter().sampleActive()).toEqual({ windowId: 2, chromeTabId: 2 });
  });

  it("keeps the window but has no tab when the active tab is not reportable", async () => {
    await openTabs(page(1), page(2, { active: true, url: "chrome://settings" }));
    expect(await snapshotter().sampleActive()).toEqual({ windowId: 1, chromeTabId: null });
  });

  it("returns null ids when no window has focus", async () => {
    await openTabs(page(1, { active: true }));
    mock.focusedWindowId = -1;
    expect(await snapshotter().sampleActive()).toEqual({ windowId: null, chromeTabId: null });
  });

  it("returns null ids for an incognito window, without naming it", async () => {
    await openTabs(page(1, { active: true }), page(2, { windowId: 2, active: true, incognito: true }));
    mock.focusedWindowId = 2;
    expect(await snapshotter().sampleActive()).toEqual({ windowId: null, chromeTabId: null });
  });
});

describe("the active sample in a request", () => {
  const fetchOk = () => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ accepted: 0, duplicates: 0 }), { status: 200 }));
  const body = (f: ReturnType<typeof fetchOk>) => JSON.parse(f.mock.calls[0][1]!.body as string) as IngestBatchRequest;
  const cfg = { ok: true, config: { apiBaseUrl: "http://localhost:8787", deviceToken: "tok" } } as const;

  it("goes out with every request", async () => {
    await openTabs(page(1, { active: true }));
    const snap = snapshotter();
    const f = fetchOk();
    await createSender({ store, getConfig: () => cfg, fetchFn: f, sampleActive: () => snap.sampleActive() }).drainOnce();
    expect(body(f).active).toEqual({ windowId: 1, chromeTabId: 1 });
  });

  it("still sends, with null ids, when sampling the active tab fails", async () => {
    await openTabs(page(1, { active: true }));
    const f = fetchOk();
    const sender = createSender({
      store,
      getConfig: () => cfg,
      fetchFn: f,
      sampleActive: async () => {
        throw new Error("no window");
      },
    });
    expect(await sender.drainOnce()).toMatchObject({ outcome: "sent" });
    expect(body(f).active).toEqual({ windowId: null, chromeTabId: null });
  });

  it("marks the window and active flag on queued snapshots", async () => {
    await openTabs(page(1, { windowId: 5, active: true }), page(2, { windowId: 5 }));
    const { dirty } = await store.readBatch(100);
    expect(dirty.map((d) => [d.entry.snapshot.chromeTabId, d.entry.snapshot.windowId, d.entry.snapshot.active])).toEqual([
      [1, 5, true],
      [2, 5, false],
    ]);
  });
});
