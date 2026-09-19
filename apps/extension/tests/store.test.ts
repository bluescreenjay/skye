import type { TabEventInput, TabSnapshotInput } from "@ai-browser/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createStore } from "../src/store";
import { installChromeMock, type ChromeMock } from "./helpers/chrome-mock";

const HOUR = 60 * 60 * 1000;

const ev = (id: string, eventType: TabEventInput["eventType"] = "updated"): TabEventInput => ({
  id,
  time: "2026-09-19T10:00:00.000Z",
  url: "https://example.com",
  title: "t",
  chromeTabId: 1,
  eventType,
});

const snap = (chromeTabId: number, title = "t"): TabSnapshotInput => ({
  chromeTabId,
  windowId: 1,
  active: false,
  url: `https://example.com/${chromeTabId}`,
  title,
  snippet: "",
  lastSeenAt: "2026-09-19T10:00:00.000Z",
});

let mock: ChromeMock;
let clock = 0;
const now = () => clock;
const newStore = (opts: { maxEvents?: number } = {}) => createStore({ now, ...opts });

beforeEach(() => {
  mock = installChromeMock();
  clock = 1_000_000;
});

describe("event backlog", () => {
  it("assigns increasing seq numbers and reads events back in order", async () => {
    const store = newStore();
    await store.apply({ events: [ev("a"), ev("b")] });
    await store.apply({ events: [ev("c")] });
    const batch = await store.readBatch(100);
    expect(batch.events.map((e) => e.event.id)).toEqual(["a", "b", "c"]);
    expect(batch.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(batch.throughSeq).toBe(2);
  });

  it("reads at most the requested number of events, oldest first", async () => {
    const store = newStore();
    await store.apply({ events: [ev("a"), ev("b"), ev("c"), ev("d"), ev("e")] });
    const batch = await store.readBatch(2);
    expect(batch.events.map((e) => e.event.id)).toEqual(["a", "b"]);
    expect(batch.throughSeq).toBe(1);
  });

  it("keeps a range until it is acknowledged", async () => {
    const store = newStore();
    await store.apply({ events: [ev("a"), ev("b")] });
    const first = await store.readBatch(100);
    const second = await store.readBatch(100);
    expect(second.events.map((e) => e.event.id)).toEqual(first.events.map((e) => e.event.id));
  });

  it("deletes an acknowledged range and delivers the rest next", async () => {
    const store = newStore();
    await store.apply({ events: [ev("a"), ev("b"), ev("c")] });
    const batch = await store.readBatch(2);
    await store.ackEvents(batch.throughSeq!);
    const next = await store.readBatch(100);
    expect(next.events.map((e) => e.event.id)).toEqual(["c"]);
    expect([...mock.storage.keys()].filter((k) => k.includes(":ev:"))).toHaveLength(1);
    expect(await store.size()).toBe(1);
  });

  it("returns an empty batch with no throughSeq when nothing is queued", async () => {
    const batch = await newStore().readBatch(100);
    expect(batch.events).toEqual([]);
    expect(batch.throughSeq).toBeNull();
  });

  it("stamps each event with the time it was queued", async () => {
    const store = newStore();
    await store.apply({ events: [ev("a")] });
    clock += 5000;
    await store.apply({ events: [ev("b")] });
    const batch = await store.readBatch(100);
    expect(batch.events.map((e) => e.queuedAt)).toEqual([1_000_000, 1_005_000]);
  });
});

describe("pending and ready snapshots", () => {
  it("keeps only the latest snapshot per tab", async () => {
    const store = newStore();
    await store.apply({ dirty: [{ tabId: 5, snapshot: snap(5, "a"), ready: false }] });
    await store.apply({ dirty: [{ tabId: 5, snapshot: snap(5, "b"), ready: false }] });
    const all = await store.listDirty();
    expect(all).toHaveLength(1);
    expect(all[0].entry.snapshot.title).toBe("b");
  });

  it("only hands out ready snapshots for delivery", async () => {
    const store = newStore();
    await store.apply({ dirty: [{ tabId: 5, snapshot: snap(5), ready: false }] });
    expect((await store.readBatch(100)).dirty).toEqual([]);
    await store.apply({ dirty: [{ tabId: 5, snapshot: snap(5), ready: true }] });
    const batch = await store.readBatch(100);
    expect(batch.dirty.map((d) => d.tabId)).toEqual([5]);
    expect(batch.dirty[0].entry.ready).toBe(true);
  });

  it("tracks firstDirtyAt and lastChangeAt for the settle and cap logic", async () => {
    const store = newStore();
    clock = 1000;
    await store.apply({ dirty: [{ tabId: 5, snapshot: snap(5), ready: false }] });
    clock = 1500;
    await store.apply({ dirty: [{ tabId: 5, snapshot: snap(5, "x"), ready: false }] });
    let [entry] = await store.listDirty();
    expect(entry.entry.firstDirtyAt).toBe(1000);
    expect(entry.entry.lastChangeAt).toBe(1500);

    clock = 2000;
    await store.apply({ dirty: [{ tabId: 5, snapshot: snap(5, "x"), ready: true }] });
    clock = 3000;
    await store.apply({ dirty: [{ tabId: 5, snapshot: snap(5, "y"), ready: false }] });
    [entry] = await store.listDirty();
    expect(entry.entry.ready).toBe(false);
    expect(entry.entry.firstDirtyAt).toBe(3000); // a ready entry that changes again starts a new wait
  });

  it("drops a pending snapshot and removes it from the index", async () => {
    const store = newStore();
    await store.apply({ dirty: [{ tabId: 5, snapshot: snap(5), ready: false }, { tabId: 6, snapshot: snap(6), ready: false }] });
    await store.apply({ dropDirty: [5] });
    expect((await store.listDirty()).map((d) => d.tabId)).toEqual([6]);
    expect([...mock.storage.keys()].some((k) => k.endsWith("dirty:5"))).toBe(false);
  });

  it("acknowledges a snapshot only if it is unchanged since the batch was built", async () => {
    const store = newStore();
    clock = 1000;
    await store.apply({ dirty: [{ tabId: 5, snapshot: snap(5, "a"), ready: true }] });
    const built = (await store.readBatch(100)).dirty[0];
    expect(built.entry.lastChangeAt).toBe(1000);

    clock = 1200; // the tab changes while the request is in flight
    await store.apply({ dirty: [{ tabId: 5, snapshot: snap(5, "c"), ready: false }] });
    expect(await store.ackDirty(5, built.entry.lastChangeAt)).toBe(false);
    const [kept] = await store.listDirty();
    expect(kept.entry.snapshot.title).toBe("c");

    clock = 1300;
    await store.apply({ dirty: [{ tabId: 5, snapshot: snap(5, "c"), ready: true }] });
    const rebuilt = (await store.readBatch(100)).dirty[0];
    expect(await store.ackDirty(5, rebuilt.entry.lastChangeAt)).toBe(true);
    expect(await store.listDirty()).toEqual([]);
  });

  it("treats acknowledging a snapshot that is already gone as a no-op", async () => {
    expect(await newStore().ackDirty(99, 1)).toBe(false);
  });
});

describe("tracked-tab mirror", () => {
  it("sets and deletes entries, keyed by tab id", async () => {
    const store = newStore();
    const entry = { url: "https://a", title: "A", windowId: 1, lastSeenAt: "2026-09-19T10:00:00.000Z" };
    await store.apply({ mirror: { 1: entry, 2: { ...entry, url: "https://b" } } });
    let mirror = await store.getMirror();
    expect([...mirror.keys()].sort()).toEqual([1, 2]);
    expect(mirror.get(1)).toEqual(entry);
    await store.apply({ mirror: { 1: null } });
    mirror = await store.getMirror();
    expect([...mirror.keys()]).toEqual([2]);
  });

  it("starts empty", async () => {
    expect((await newStore().getMirror()).size).toBe(0);
  });
});

describe("snippet cache", () => {
  it("remembers the last snippet per tab, with the address it was read from", async () => {
    const store = newStore();
    expect(await store.getSnippet(1)).toBeUndefined();
    await store.apply({ snippets: { 1: { url: "https://a", text: "A text" }, 2: { url: "https://b", text: "B text" } } });
    expect(await store.getSnippet(1)).toEqual({ url: "https://a", text: "A text" });
    expect(await store.getSnippet(2)).toEqual({ url: "https://b", text: "B text" });
  });

  it("forgets a tab's snippet when it is set to null", async () => {
    const store = newStore();
    await store.apply({ snippets: { 1: { url: "https://a", text: "A" } } });
    await store.apply({ snippets: { 1: null } });
    expect(await store.getSnippet(1)).toBeUndefined();
    expect([...mock.storage.keys()].some((k) => k.endsWith("snip:1"))).toBe(false);
  });

  it("is written in the same storage.local.set as the events and snapshots it belongs to", async () => {
    const store = newStore();
    const before = mock.storageCalls.set;
    await store.apply({
      events: [ev("a")],
      dirty: [{ tabId: 1, snapshot: snap(1), ready: true }],
      snippets: { 1: { url: "https://example.com/1", text: "hello" } },
    });
    expect(mock.storageCalls.set - before).toBe(1);
  });

  it("never puts a snippet in an event or the event backlog", async () => {
    const store = newStore();
    await store.apply({ events: [ev("a")], snippets: { 1: { url: "https://a", text: "secret page text" } } });
    const batch = await store.readBatch(100);
    expect(JSON.stringify(batch.events)).not.toContain("secret page text");
  });
});

describe("sync state", () => {
  it("has defaults", async () => {
    expect(await newStore().getState()).toEqual({
      status: "idle",
      needsFullSnapshot: false,
      attempt: 0,
      nextAttemptAt: null,
      lastSuccessAt: null,
      droppedForAge: 0,
      quarantinedInvalid: 0,
    });
  });

  it("merges updates and persists them", async () => {
    const store = newStore();
    const next = await store.updateState({ status: "retrying", attempt: 2 });
    expect(next.status).toBe("retrying");
    expect(next.droppedForAge).toBe(0);
    expect((await newStore().getState()).attempt).toBe(2);
  });
});

describe("prune", () => {
  it("drops events older than 24 hours, oldest first, and notes the gap", async () => {
    const store = newStore();
    clock = 0;
    await store.apply({ events: [ev("old1"), ev("old2")] });
    clock = 12 * HOUR;
    await store.apply({ events: [ev("recent")] });
    clock = 24 * HOUR + 1;

    expect(await store.prune()).toBe(2);
    expect((await store.readBatch(100)).events.map((e) => e.event.id)).toEqual(["recent"]);
    const state = await store.getState();
    expect(state.droppedForAge).toBe(2);
    expect(state.needsFullSnapshot).toBe(true);
  });

  it("keeps an event that is exactly 24 hours old", async () => {
    const store = newStore();
    clock = 0;
    await store.apply({ events: [ev("edge")] });
    clock = 24 * HOUR;
    expect(await store.prune()).toBe(0);
  });

  it("applies the event-count ceiling on the same path, oldest first", async () => {
    const store = newStore({ maxEvents: 5 });
    await store.apply({ events: ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => ev(id)) });
    expect(await store.prune()).toBe(3);
    expect((await store.readBatch(100)).events.map((e) => e.event.id)).toEqual(["d", "e", "f", "g", "h"]);
    expect((await store.getState()).needsFullSnapshot).toBe(true);
  });

  it("does nothing, and sets no gap, when nothing is too old or too many", async () => {
    const store = newStore();
    await store.apply({ events: [ev("a")] });
    expect(await store.prune()).toBe(0);
    const state = await store.getState();
    expect(state.droppedForAge).toBe(0);
    expect(state.needsFullSnapshot).toBe(false);
  });

  it("clears a backlog larger than one internal read chunk", async () => {
    const store = newStore();
    clock = 0;
    await store.apply({ events: Array.from({ length: 1200 }, (_, i) => ev(`e${i}`)) });
    clock = 25 * HOUR;
    expect(await store.prune()).toBe(1200);
    expect(await store.size()).toBe(0);
    expect([...mock.storage.keys()].filter((k) => k.includes(":ev:"))).toHaveLength(0);
  });
});

describe("atomicity, restart, and ordering", () => {
  it("writes events, snapshots, and the mirror in a single storage.local.set", async () => {
    const store = newStore();
    const before = mock.storageCalls.set;
    await store.apply({
      events: [ev("a")],
      dirty: [{ tabId: 5, snapshot: snap(5), ready: false }],
      mirror: { 5: { url: "https://a", title: "A", windowId: 1, lastSeenAt: "2026-09-19T10:00:00.000Z" } },
    });
    expect(mock.storageCalls.set - before).toBe(1);
  });

  it("survives a worker restart: a new store over the same storage sees the same data", async () => {
    const before = newStore();
    await before.apply({ events: [ev("a")], dirty: [{ tabId: 5, snapshot: snap(5), ready: true }] });
    await before.updateState({ status: "retrying" });

    const after = newStore();
    const batch = await after.readBatch(100);
    expect(batch.events.map((e) => e.event.id)).toEqual(["a"]);
    expect(batch.dirty.map((d) => d.tabId)).toEqual([5]);
    expect((await after.getState()).status).toBe("retrying");

    await after.apply({ events: [ev("b")] });
    expect((await after.readBatch(100)).events.map((e) => e.seq)).toEqual([0, 1]);
  });

  it("serialises concurrent updates so sequence numbers never collide", async () => {
    const store = newStore();
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.apply({ events: [ev(`e${i}`)] })));
    const batch = await store.readBatch(100);
    expect(batch.events.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(batch.events.map((e) => e.event.id)).toEqual(Array.from({ length: 20 }, (_, i) => `e${i}`));
  });
});
