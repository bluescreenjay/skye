import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSnapshotter } from "../src/snapshot";
import { createStore, type Store } from "../src/store";
import { installChromeMock, type ChromeMock, type MockTab } from "./helpers/chrome-mock";

const T0 = Date.parse("2026-09-19T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

let mock: ChromeMock;
let store: Store;
let clock: number;
let queued: number;

beforeEach(() => {
  mock = installChromeMock();
  clock = T0;
  store = createStore({ now: () => clock });
  queued = 0;
});

const snapshotter = () => createSnapshotter({ store, now: () => clock, onQueued: () => void queued++ });

const page = (id: number, over: Partial<MockTab> = {}): MockTab => ({
  id,
  windowId: 1,
  url: `https://example.com/${id}`,
  title: `Page ${id}`,
  active: false,
  ...over,
});

const kinds = async () => (await store.readBatch(1000)).events.map((e) => `${e.event.eventType}:${e.event.chromeTabId}`);

describe("reconcile", () => {
  it("reports new tabs as opened and queues a ready snapshot for every eligible tab", async () => {
    const s = snapshotter();
    await s.reconcile([page(1, { active: true }), page(2, { windowId: 2 })]);

    expect(await kinds()).toEqual(["opened:1", "opened:2"]);
    const { dirty } = await store.readBatch(100);
    expect(dirty.map((d) => d.tabId)).toEqual([1, 2]);
    expect(dirty[0].entry.snapshot).toMatchObject({
      chromeTabId: 1,
      windowId: 1,
      active: true,
      url: "https://example.com/1",
      title: "Page 1",
      snippet: "",
      lastSeenAt: iso(T0),
    });
    expect(dirty[1].entry.snapshot).toMatchObject({ windowId: 2, active: false });
    expect([...(await store.getMirror()).keys()]).toEqual([1, 2]);
    expect(queued).toBeGreaterThan(0);
  });

  it("ignores incognito tabs and pages that are not http(s)", async () => {
    const s = snapshotter();
    await s.reconcile([
      page(1),
      page(2, { incognito: true }),
      page(3, { url: "chrome://settings" }),
      page(4, { url: "chrome-extension://abc/x.html" }),
      page(5, { url: "file:///tmp/a.txt" }),
      page(6, { url: undefined }),
    ]);
    expect(await kinds()).toEqual(["opened:1"]);
    expect([...(await store.getMirror()).keys()]).toEqual([1]);
    expect((await store.readBatch(100)).dirty.map((d) => d.tabId)).toEqual([1]);
  });

  it("reports a tab that is gone as closed, using its last reported address and title", async () => {
    const s = snapshotter();
    await s.reconcile([page(1), page(2)]);
    clock += 5000;
    await s.reconcile([page(1)]);

    expect(await kinds()).toEqual(["opened:1", "opened:2", "closed:2"]);
    const closed = (await store.readBatch(100)).events.at(-1)!.event;
    expect(closed.url).toBe("https://example.com/2");
    expect(closed.title).toBe("Page 2");
    expect([...(await store.getMirror()).keys()]).toEqual([1]);
    expect((await store.readBatch(100)).dirty.map((d) => d.tabId)).toEqual([1]);
  });

  it("reports a tab whose address or title changed as updated", async () => {
    const s = snapshotter();
    await s.reconcile([page(1, { title: "Old" })]);
    await s.reconcile([page(1, { title: "New" })]);
    expect(await kinds()).toEqual(["opened:1", "updated:1"]);
    expect((await store.readBatch(100)).events[1].event.title).toBe("New");
  });

  it("emits no events for an unchanged tab but still queues its snapshot again", async () => {
    const s = snapshotter();
    await s.reconcile([page(1)]);
    const first = (await store.readBatch(100)).dirty[0];
    await store.ackDirty(1, first.entry.lastChangeAt);
    expect((await store.readBatch(100)).dirty).toEqual([]);

    clock += 1000;
    await s.reconcile([page(1)]);
    expect(await kinds()).toEqual(["opened:1"]);
    expect((await store.readBatch(100)).dirty.map((d) => d.tabId)).toEqual([1]);
  });

  it("drops pending snapshots of tabs that no longer exist", async () => {
    await store.apply({
      dirty: [{ tabId: 77, ready: false, snapshot: { chromeTabId: 77, windowId: 1, active: false, url: "https://x", title: "x", snippet: "", lastSeenAt: iso(T0) } }],
    });
    await snapshotter().reconcile([page(1)]);
    expect((await store.listDirty()).map((d) => d.tabId)).toEqual([1]);
  });

  it("reports tabs it has already mirrored as unchanged when the list is identical", async () => {
    const s = snapshotter();
    await s.reconcile([page(1), page(2)]);
    await s.reconcile([page(1), page(2)]);
    expect(await kinds()).toEqual(["opened:1", "opened:2"]);
  });
});

describe("takeFullSnapshot", () => {
  it("asks Chrome for every tab, then reconciles", async () => {
    mock.tabs = [page(1), page(2, { incognito: true }), page(3, { url: "chrome://newtab" }), page(4)];
    await snapshotter().takeFullSnapshot();
    expect(await kinds()).toEqual(["opened:1", "opened:4"]);
  });
});

describe("resetForBrowserStart", () => {
  it("closes every tab remembered from the previous session at the time it was last seen, then forgets them", async () => {
    const s = snapshotter();
    await s.reconcile([page(1), page(2)]);
    clock = T0 + 60_000;
    await s.reconcile([page(1), page(2)]); // last seen at T0 + 60 s
    clock = T0 + 3_600_000; // the browser was closed a long time ago; now it starts again
    await store.ackEvents((await store.readBatch(100)).throughSeq!);

    await s.resetForBrowserStart();
    const { events, dirty } = await store.readBatch(100);
    expect(events.map((e) => `${e.event.eventType}:${e.event.chromeTabId}`)).toEqual(["closed:1", "closed:2"]);
    expect(events.map((e) => e.event.time)).toEqual([iso(T0 + 60_000), iso(T0 + 60_000)]);
    expect((await store.getMirror()).size).toBe(0);
    expect(dirty).toEqual([]);
    expect(await store.listDirty()).toEqual([]);
  });

  it("lets the following full snapshot report the restored tabs as newly opened", async () => {
    const s = snapshotter();
    await s.reconcile([page(1)]);
    await store.ackEvents((await store.readBatch(100)).throughSeq!);

    await s.resetForBrowserStart();
    mock.tabs = [page(11, { url: "https://example.com/1", title: "Page 1" })]; // same page, new tab id after restart
    await s.takeFullSnapshot();
    expect(await kinds()).toEqual(["closed:1", "opened:11"]);
  });

  it("does nothing when there was nothing to forget", async () => {
    await snapshotter().resetForBrowserStart();
    expect(await kinds()).toEqual([]);
  });
});
