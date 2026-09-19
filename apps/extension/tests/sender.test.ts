import type { IngestBatchRequest, TabEventInput, TabSnapshotInput } from "@ai-browser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigResult } from "../src/config";
import { createDrainScheduler, createSender } from "../src/sender";
import { createStore, type Store } from "../src/store";
import { installChromeMock } from "./helpers/chrome-mock";

const T0 = Date.parse("2026-09-19T10:00:00.000Z");
const cfg: ConfigResult = { ok: true, config: { apiBaseUrl: "http://localhost:8787", deviceToken: "tok" } };
const OK = () => new Response(JSON.stringify({ accepted: 0, duplicates: 0 }), { status: 200 });

let store: Store;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  installChromeMock();
  store = createStore({ now: () => Date.now() });
  fetchMock = vi.fn<typeof fetch>(async () => OK());
});

afterEach(() => {
  vi.useRealTimers();
});

const ev = (id: string, tab = 1): TabEventInput => ({
  id,
  time: new Date(T0).toISOString(),
  url: "https://example.com",
  title: "t",
  chromeTabId: tab,
  eventType: "updated",
});

const snap = (tab: number, title = "t"): TabSnapshotInput => ({
  chromeTabId: tab,
  windowId: 1,
  active: false,
  url: `https://example.com/${tab}`,
  title,
  snippet: "",
  lastSeenAt: new Date(T0).toISOString(),
});

const sender = (extra: Record<string, unknown> = {}) =>
  createSender({ store, getConfig: () => cfg, fetchFn: fetchMock, now: () => Date.now(), ...extra });

const sentBody = (call = 0) => JSON.parse(fetchMock.mock.calls[call][1]!.body as string) as IngestBatchRequest;

describe("drainOnce: building the request", () => {
  it("does nothing when there is nothing to send", async () => {
    expect(await sender().drainOnce()).toEqual({ outcome: "empty" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send when the extension is misconfigured", async () => {
    await store.apply({ events: [ev("a")] });
    const s = createSender({ store, getConfig: () => ({ ok: false, reason: "x" }), fetchFn: fetchMock });
    expect(await s.drainOnce()).toEqual({ outcome: "misconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs to the ingest endpoint with the bearer token and a JSON body", async () => {
    await store.apply({ events: [ev("a")] });
    await sender().drainOnce();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8787/api/ingest/tabs");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sends a request that matches the contract", async () => {
    await store.apply({
      events: [ev("a"), ev("b")],
      dirty: [{ tabId: 1, snapshot: snap(1), ready: true }],
    });
    await sender({ uuid: () => "batch-1" }).drainOnce();

    const body = sentBody();
    expect(body.batchId).toBe("batch-1");
    expect(body.sentAt).toBe(new Date(T0).toISOString());
    expect(body.fullSnapshot).toBe(false);
    expect(body.active).toEqual({ windowId: null, chromeTabId: null });
    expect(body.events.map((e) => e.id)).toEqual(["a", "b"]);
    expect(body.tabs.map((t) => t.chromeTabId)).toEqual([1]);
  });

  it("takes at most 100 events per request, oldest first, and sends the rest next", async () => {
    await store.apply({ events: Array.from({ length: 150 }, (_, i) => ev(`e${i}`)) });
    const s = sender();

    expect(await s.drainOnce()).toMatchObject({ outcome: "sent" });
    expect(sentBody(0).events).toHaveLength(100);
    expect(sentBody(0).events[0].id).toBe("e0");

    expect(await s.drainOnce()).toMatchObject({ outcome: "sent" });
    expect(sentBody(1).events.map((e) => e.id)).toEqual(Array.from({ length: 50 }, (_, i) => `e${100 + i}`));
  });

  it("leaves out snapshots that are still settling", async () => {
    await store.apply({
      dirty: [
        { tabId: 1, snapshot: snap(1), ready: true },
        { tabId: 2, snapshot: snap(2), ready: false },
      ],
    });
    await sender().drainOnce();
    expect(sentBody().tabs.map((t) => t.chromeTabId)).toEqual([1]);
  });
});

describe("drainOnce: acknowledging", () => {
  it("removes the sent events and snapshots after a 200", async () => {
    await store.apply({ events: [ev("a")], dirty: [{ tabId: 1, snapshot: snap(1), ready: true }] });
    expect(await sender().drainOnce()).toMatchObject({ outcome: "sent" });
    expect((await store.readBatch(100)).events).toEqual([]);
    expect(await store.listDirty()).toEqual([]);
  });

  it("keeps a snapshot that changed while the request was in flight", async () => {
    await store.apply({ dirty: [{ tabId: 1, snapshot: snap(1, "before"), ready: true }] });
    fetchMock.mockImplementationOnce(async () => {
      vi.setSystemTime(T0 + 500); // the tab changes while the request is on the wire
      await store.apply({ dirty: [{ tabId: 1, snapshot: snap(1, "after"), ready: false }] });
      return OK();
    });

    await sender().drainOnce();
    const [kept] = await store.listDirty();
    expect(kept.entry.snapshot.title).toBe("after");
  });

  it("keeps events that were queued while the request was in flight", async () => {
    await store.apply({ events: [ev("a")] });
    fetchMock.mockImplementationOnce(async () => {
      await store.apply({ events: [ev("late")] });
      return OK();
    });
    await sender().drainOnce();
    expect((await store.readBatch(100)).events.map((e) => e.event.id)).toEqual(["late"]);
  });

  it("leaves everything queued when the server does not answer 200", async () => {
    await store.apply({ events: [ev("a")], dirty: [{ tabId: 1, snapshot: snap(1), ready: true }] });
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    const result = await sender().drainOnce();
    expect(result).toMatchObject({ outcome: "failed", status: 500 });
    expect((await store.readBatch(100)).events.map((e) => e.event.id)).toEqual(["a"]);
    expect(await store.listDirty()).toHaveLength(1);
  });

  it("leaves everything queued when the request throws", async () => {
    await store.apply({ events: [ev("a")] });
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await sender().drainOnce()).toMatchObject({ outcome: "failed" });
    expect((await store.readBatch(100)).events).toHaveLength(1);
  });
});

describe("drainOnce: one request at a time", () => {
  it("answers 'busy' instead of starting a second request while one is in flight", async () => {
    await store.apply({ events: [ev("a")] });
    let release!: () => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(OK()))));

    const s = sender();
    const first = s.drainOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(await s.drainOnce()).toEqual({ outcome: "busy" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release();
    expect(await first).toMatchObject({ outcome: "sent" });
  });
});

describe("full snapshots", () => {
  it("takes a fresh snapshot first, then lists every tab, settling ones included", async () => {
    await store.updateState({ needsFullSnapshot: true });
    const takeFullSnapshot = vi.fn(async () => {
      await store.apply({
        dirty: [
          { tabId: 1, snapshot: snap(1), ready: true },
          { tabId: 2, snapshot: snap(2), ready: false }, // changed again right after the snapshot
        ],
      });
    });

    await sender({ takeFullSnapshot }).drainOnce();

    expect(takeFullSnapshot).toHaveBeenCalledTimes(1);
    const body = sentBody();
    expect(body.fullSnapshot).toBe(true);
    expect(body.tabs.map((t) => t.chromeTabId)).toEqual([1, 2]); // a full snapshot must not omit open tabs
  });

  it("clears the request for a full snapshot once the server acknowledged it", async () => {
    await store.updateState({ needsFullSnapshot: true });
    const takeFullSnapshot = async () => {
      await store.apply({ dirty: [{ tabId: 1, snapshot: snap(1), ready: true }] });
    };
    const s = sender({ takeFullSnapshot });
    await s.drainOnce();
    expect((await store.getState()).needsFullSnapshot).toBe(false);

    await store.apply({ events: [ev("a")] });
    await s.drainOnce();
    expect(sentBody(1).fullSnapshot).toBe(false);
  });

  it("keeps asking for a full snapshot while the server is failing", async () => {
    await store.updateState({ needsFullSnapshot: true });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
    const takeFullSnapshot = async () => {
      await store.apply({ dirty: [{ tabId: 1, snapshot: snap(1), ready: true }] });
    };
    await sender({ takeFullSnapshot }).drainOnce();
    expect((await store.getState()).needsFullSnapshot).toBe(true);
  });
});

describe("createDrainScheduler", () => {
  it("runs one drain about a second after the first queued change, however many follow", async () => {
    const drain = vi.fn(async () => undefined);
    const scheduler = createDrainScheduler({ drain, delayMs: 1000 });

    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(300);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(300);
    scheduler.schedule();
    expect(drain).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);
    expect(drain).toHaveBeenCalledTimes(1);

    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it("delivers a queued event within about a second without waiting for the heartbeat", async () => {
    const s = sender();
    const scheduler = createDrainScheduler({ drain: () => s.drainOnce(), delayMs: 1000 });

    await store.apply({ events: [ev("a")] });
    scheduler.schedule(); // what the collector's onQueued does
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody().events.map((e) => e.id)).toEqual(["a"]);
  });

  it("does not let a failing drain break later ones", async () => {
    const drain = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const scheduler = createDrainScheduler({ drain, delayMs: 100, onError: () => undefined });
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(100);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(drain).toHaveBeenCalledTimes(2);
  });
});
