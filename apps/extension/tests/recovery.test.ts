import type { IngestBatchRequest } from "@ai-browser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollector } from "../src/collector";
import { createHeartbeat, resetSyncState } from "../src/heartbeat";
import { createSender } from "../src/sender";
import { createSnapshotter } from "../src/snapshot";
import { applyStatus, badgeFor } from "../src/status";
import { createStore, type Store } from "../src/store";
import { installChromeMock, type ChromeMock, type MockTab } from "./helpers/chrome-mock";

const T0 = Date.parse("2026-09-19T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const cfg = { ok: true, config: { apiBaseUrl: "http://localhost:8787", deviceToken: "tok" } } as const;

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

afterEach(() => {
  vi.useRealTimers();
});

const page = (id: number, over: Partial<MockTab> = {}): MockTab => ({
  id,
  windowId: 1,
  url: `https://example.com/${id}`,
  title: `Page ${id}`,
  active: false,
  ...over,
});

/** A whole "worker": the same wiring background.ts does, over one shared store. */
function worker(opts: { setTimer?: () => unknown } = {}) {
  const snapshotter = createSnapshotter({ store, now: () => Date.now() });
  const sender = createSender({
    store,
    getConfig: () => cfg,
    fetchFn: fetchMock,
    now: () => Date.now(),
    random: () => 0.5,
    takeFullSnapshot: () => snapshotter.takeFullSnapshot(),
    sampleActive: () => snapshotter.sampleActive(),
  });
  const collector = createCollector({ store, now: () => Date.now(), ...opts });
  const heartbeat = createHeartbeat({ store, collector, sender, applyStatus });
  return { snapshotter, sender, collector, heartbeat };
}

const bodyOf = (call: number) => JSON.parse(fetchMock.mock.calls[call][1]!.body as string) as IngestBatchRequest;
const queuedKinds = async () => (await store.readBatch(1000)).events.map((e) => `${e.event.eventType}:${e.event.chromeTabId}`);

describe("after the worker was stopped", () => {
  it("delivers a pending update on the next heartbeat even though its timer was lost", async () => {
    const before = worker({ setTimer: () => 0 }); // the worker is stopped before any timer fires
    const tab = page(1, { title: "A" });
    mock.tabs = [tab];
    await before.collector.onTabCreated(tab);
    const changed = page(1, { title: "B" });
    mock.tabs = [changed];
    await before.collector.onTabUpdated(1, { title: "B" }, changed);

    vi.setSystemTime(T0 + 2500); // long enough to have settled
    await worker().heartbeat(); // a fresh worker woken by the alarm

    expect(await queuedKinds()).toEqual([]); // delivered and acknowledged
    expect(bodyOf(0).events.map((e) => `${e.eventType}:${e.chromeTabId}`)).toEqual(["opened:1", "updated:1"]);
    expect(bodyOf(0).events[1].title).toBe("B");
  });

  it("sends every tab in a full snapshot right after a reset, before anything else", async () => {
    mock.tabs = [page(1, { active: true }), page(2)];
    await store.apply({
      events: [
        { id: "old", time: new Date(T0).toISOString(), chromeTabId: 9, url: "https://x", title: "x", eventType: "opened" },
      ],
    });
    await resetSyncState(store);
    await worker().heartbeat();

    const body = bodyOf(0);
    expect(body.fullSnapshot).toBe(true);
    expect(body.tabs.map((t) => t.chromeTabId).sort()).toEqual([1, 2]);
    expect(body.events.map((e) => e.id)[0]).toBe("old"); // earlier events keep their place at the front
    expect((await store.getState()).needsFullSnapshot).toBe(false);
  });
});

describe("a gap in delivery", () => {
  it("ages out events older than 24 hours before batching, and follows with a full snapshot", async () => {
    mock.tabs = [page(1, { active: true })];
    const w = worker();
    await w.collector.onTabCreated(mock.tabs[0]); // an event queued now
    fetchMock.mockResolvedValue(new Response("down", { status: 503 }));
    await w.heartbeat(); // the backend is down; it stays queued
    expect(await queuedKinds()).toEqual(["opened:1"]);

    vi.setSystemTime(T0 + 25 * HOUR); // ... for more than a day
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ accepted: 0, duplicates: 0 }), { status: 200 }));
    await store.updateState({ nextAttemptAt: null }); // the retry time has long passed
    await w.heartbeat();

    const state = await store.getState();
    expect(state.droppedForAge).toBe(1);
    const last = bodyOf(fetchMock.mock.calls.length - 1);
    expect(last.fullSnapshot).toBe(true); // the gap is repaired by a fresh snapshot
    expect(last.events.every((e) => e.eventType !== "opened" || e.chromeTabId === 1)).toBe(true);
    expect(last.events.find((e) => e.id && e.time === new Date(T0).toISOString())).toBeUndefined(); // the old event is gone
    expect(state.needsFullSnapshot).toBe(false);
  });

  it("keeps asking for the full snapshot across heartbeats until the server acknowledges one", async () => {
    mock.tabs = [page(1, { active: true })];
    const w = worker();
    await store.updateState({ needsFullSnapshot: true });
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));

    await w.heartbeat();
    expect((await store.getState()).needsFullSnapshot).toBe(true);
    vi.setSystemTime(T0 + 10_000);
    await w.heartbeat();
    expect((await store.getState()).needsFullSnapshot).toBe(true);

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ accepted: 1, duplicates: 0 }), { status: 200 }));
    vi.setSystemTime(T0 + 20 * 60_000);
    await w.heartbeat();
    expect((await store.getState()).needsFullSnapshot).toBe(false);
    expect(bodyOf(fetchMock.mock.calls.length - 1).fullSnapshot).toBe(true);
  });

  it("does not prune, or ask for a snapshot, when nothing is old", async () => {
    mock.tabs = [page(1, { active: true })];
    const w = worker();
    await w.collector.onTabCreated(mock.tabs[0]);
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    await w.heartbeat();
    expect((await store.getState()).droppedForAge).toBe(0);
    expect((await store.getState()).needsFullSnapshot).toBe(false);
  });
});

describe("rejected credentials across a reload", () => {
  it("stays stopped until the session is reset, then recovers with a full snapshot and no lost events", async () => {
    mock.tabs = [page(1, { active: true })];
    const w = worker();
    await w.collector.onTabCreated(mock.tabs[0]);
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
    await w.heartbeat();
    expect((await store.getState()).status).toBe("auth_failed");
    expect(await queuedKinds()).toEqual(["opened:1"]); // nothing dropped

    vi.setSystemTime(T0 + HOUR);
    await w.heartbeat();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry loop

    await resetSyncState(store); // what a reload with fixed credentials does
    await w.heartbeat();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(1).fullSnapshot).toBe(true);
    expect(bodyOf(1).events.map((e) => e.eventType)).toContain("opened");
    expect((await store.getState()).status).toBe("ok");
  });

  it("resetSyncState clears the stuck status and asks for a snapshot", async () => {
    await store.updateState({ status: "auth_failed", attempt: 4, nextAttemptAt: T0 + 10_000 });
    await resetSyncState(store);
    expect(await store.getState()).toMatchObject({
      status: "idle",
      attempt: 0,
      nextAttemptAt: null,
      needsFullSnapshot: true,
    });
  });
});

describe("the status badge", () => {
  it.each([
    ["idle", ""],
    ["ok", ""],
    ["retrying", "…"],
    ["auth_failed", "!"],
    ["misconfigured", "!"],
  ] as const)("shows %j as %j", async (status, text) => {
    expect(badgeFor(status).text).toBe(text);
    await applyStatus(status);
    expect(mock.badge.text).toBe(text);
  });

  it("uses red for problems that need a person, and leaves the colour alone otherwise", async () => {
    await applyStatus("auth_failed");
    expect(mock.badge.color).toBe("#d93025");
    expect(badgeFor("retrying").color).toBeUndefined();
  });

  it("follows the heartbeat: '…' while retrying, '!' after rejected credentials, cleared on success", async () => {
    mock.tabs = [page(1, { active: true })];
    const w = worker();
    await w.collector.onTabCreated(mock.tabs[0]);

    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
    await w.heartbeat();
    expect(mock.badge.text).toBe("…");

    vi.setSystemTime(T0 + HOUR);
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
    await w.heartbeat();
    expect(mock.badge.text).toBe("!");

    await resetSyncState(store);
    vi.setSystemTime(T0 + 2 * HOUR);
    await w.heartbeat();
    expect(mock.badge.text).toBe("");
  });

  it("never throws if the badge cannot be set", async () => {
    (globalThis as { chrome?: unknown }).chrome = {};
    await expect(applyStatus("auth_failed")).resolves.toBeUndefined();
  });
});
