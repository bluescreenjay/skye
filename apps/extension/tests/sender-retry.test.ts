import type { IngestBatchRequest, TabEventInput, TabSnapshotInput } from "@ai-browser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigResult } from "../src/config";
import { createSender } from "../src/sender";
import { createStore, type Store } from "../src/store";
import { installChromeMock } from "./helpers/chrome-mock";

const T0 = Date.parse("2026-09-19T10:00:00.000Z");
const cfg: ConfigResult = { ok: true, config: { apiBaseUrl: "http://localhost:8787", deviceToken: "tok" } };
const ok = (body: object = { accepted: 0, duplicates: 0 }) => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number, headers: Record<string, string> = {}) => new Response("", { status: code, headers });

let store: Store;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  installChromeMock();
  store = createStore({ now: () => Date.now() });
  fetchMock = vi.fn<typeof fetch>(async () => ok());
});

afterEach(() => {
  vi.useRealTimers();
});

const ev = (id: string): TabEventInput => ({
  id,
  time: new Date(T0).toISOString(),
  url: "https://example.com",
  title: "t",
  chromeTabId: 1,
  eventType: "updated",
});

const snap = (tab: number): TabSnapshotInput => ({
  chromeTabId: tab,
  windowId: 1,
  active: false,
  url: `https://example.com/${tab}`,
  title: "t",
  snippet: "",
  lastSeenAt: new Date(T0).toISOString(),
});

// random() = 0.5 means "no jitter", so delays are exactly the base values.
const sender = (extra: Record<string, unknown> = {}) =>
  createSender({ store, getConfig: () => cfg, fetchFn: fetchMock, now: () => Date.now(), random: () => 0.5, ...extra });

const bodyOf = (call: number) => JSON.parse(fetchMock.mock.calls[call][1]!.body as string) as IngestBatchRequest;
const idsOf = (call: number) => bodyOf(call).events.map((e) => e.id);
const queuedIds = async () => (await store.readBatch(1000)).events.map((e) => e.event.id);

describe("transient failures keep everything and retry later", () => {
  it.each([
    ["a network error", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a timeout", () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError"))],
    ["408", () => Promise.resolve(status(408))],
    ["429", () => Promise.resolve(status(429))],
    ["500", () => Promise.resolve(status(500))],
    ["503", () => Promise.resolve(status(503))],
    ["404 (a wrong address must never cost data)", () => Promise.resolve(status(404))],
  ])("%s: nothing is dropped and the extension shows 'retrying'", async (_name, respond) => {
    await store.apply({ events: [ev("a"), ev("b")], dirty: [{ tabId: 1, snapshot: snap(1), ready: true }] });
    fetchMock.mockImplementationOnce(respond);

    const result = await sender().drainOnce();
    expect(result.outcome).toBe("failed");
    expect(await queuedIds()).toEqual(["a", "b"]);
    expect(await store.listDirty()).toHaveLength(1);
    const state = await store.getState();
    expect(state.status).toBe("retrying");
    expect(state.attempt).toBe(1);
  });

  it("backs off 2 s, 4 s, 8 s ... and never waits longer than 5 minutes", async () => {
    await store.apply({ events: [ev("a")] });
    fetchMock.mockImplementation(async () => status(500));
    const s = sender();

    const delays: number[] = [];
    for (let i = 0; i < 11; i++) {
      await s.drainOnce();
      const state = await store.getState();
      delays.push(state.nextAttemptAt! - Date.now());
      vi.setSystemTime(state.nextAttemptAt!);
    }
    expect(delays).toEqual([2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000, 300000]);
  });

  it("adds jitter of up to 20% either way", async () => {
    await store.apply({ events: [ev("a")] });
    fetchMock.mockImplementation(async () => status(500));

    await sender({ random: () => 0 }).drainOnce();
    expect((await store.getState()).nextAttemptAt! - Date.now()).toBe(1600);

    await store.updateState({ attempt: 0, nextAttemptAt: null });
    await sender({ random: () => 1 }).drainOnce();
    expect((await store.getState()).nextAttemptAt! - Date.now()).toBe(2400);
  });

  it("does not hammer the server: it waits until the retry time, then sends again", async () => {
    await store.apply({ events: [ev("a")] });
    fetchMock.mockResolvedValueOnce(status(500));
    const s = sender();

    await s.drainOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 1999);
    expect(await s.drainOnce()).toMatchObject({ outcome: "waiting" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 2000);
    expect(await s.drainOnce()).toMatchObject({ outcome: "sent" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses Retry-After (seconds) instead of the computed delay", async () => {
    await store.apply({ events: [ev("a")] });
    fetchMock.mockResolvedValueOnce(status(429, { "Retry-After": "45" }));
    await sender().drainOnce();
    expect((await store.getState()).nextAttemptAt).toBe(T0 + 45_000);
  });

  it("uses Retry-After given as an HTTP date", async () => {
    await store.apply({ events: [ev("a")] });
    fetchMock.mockResolvedValueOnce(status(503, { "Retry-After": new Date(T0 + 90_000).toUTCString() }));
    await sender().drainOnce();
    expect((await store.getState()).nextAttemptAt).toBe(T0 + 90_000);
  });

  it("ignores a Retry-After it cannot read", async () => {
    await store.apply({ events: [ev("a")] });
    fetchMock.mockResolvedValueOnce(status(429, { "Retry-After": "soon" }));
    await sender().drainOnce();
    expect((await store.getState()).nextAttemptAt).toBe(T0 + 2000);
  });

  it("recovers: a success clears the retry state", async () => {
    await store.apply({ events: [ev("a")] });
    fetchMock.mockResolvedValueOnce(status(500));
    const s = sender();
    await s.drainOnce();
    vi.setSystemTime(T0 + 2000);
    await s.drainOnce();

    const state = await store.getState();
    expect(state).toMatchObject({ status: "ok", attempt: 0, nextAttemptAt: null });
    expect(state.lastSuccessAt).not.toBeNull();
    expect(await queuedIds()).toEqual([]);
  });

  it("retries exactly the same events in the same order, with new ones after them", async () => {
    await store.apply({ events: [ev("a"), ev("b"), ev("c")] });
    fetchMock.mockResolvedValueOnce(status(500));
    const s = sender();
    await s.drainOnce();
    await store.apply({ events: [ev("d")] }); // queued while waiting

    vi.setSystemTime(T0 + 2000);
    await s.drainOnce();
    expect(idsOf(0)).toEqual(["a", "b", "c"]);
    expect(idsOf(1)).toEqual(["a", "b", "c", "d"]);
    expect(bodyOf(1).batchId).not.toBe(bodyOf(0).batchId);
  });

  it("acknowledges a 200 that reports duplicates", async () => {
    await store.apply({ events: [ev("a"), ev("b")] });
    fetchMock.mockResolvedValueOnce(ok({ accepted: 0, duplicates: 2 }));
    expect(await sender().drainOnce()).toEqual({ outcome: "sent", accepted: 0, duplicates: 2 });
    expect(await queuedIds()).toEqual([]);
  });
});

describe("rejected credentials", () => {
  it.each([401, 403])("%i: stops sending, drops nothing, and asks for a fresh snapshot later", async (code) => {
    await store.apply({ events: [ev("a")], dirty: [{ tabId: 1, snapshot: snap(1), ready: true }] });
    fetchMock.mockResolvedValueOnce(status(code));
    const s = sender();

    expect(await s.drainOnce()).toEqual({ outcome: "auth_failed" });
    const state = await store.getState();
    expect(state.status).toBe("auth_failed");
    expect(state.needsFullSnapshot).toBe(true);
    expect(await queuedIds()).toEqual(["a"]);
    expect(await store.listDirty()).toHaveLength(1);

    // No tight loop: later drains do not even reach the network.
    vi.setSystemTime(T0 + 3_600_000);
    expect(await s.drainOnce()).toEqual({ outcome: "auth_failed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recovers once the status is reset, sending a full snapshot before anything else", async () => {
    await store.apply({ events: [ev("a")] });
    fetchMock.mockResolvedValueOnce(status(401));
    const takeFullSnapshot = vi.fn(async () => {
      await store.apply({ dirty: [{ tabId: 1, snapshot: snap(1), ready: true }] });
    });
    const s = sender({ takeFullSnapshot });
    await s.drainOnce();

    await store.updateState({ status: "idle", attempt: 0, nextAttemptAt: null }); // what a reload or browser start does
    expect(await s.drainOnce()).toMatchObject({ outcome: "sent" });
    expect(takeFullSnapshot).toHaveBeenCalledTimes(1);
    expect(bodyOf(1).fullSnapshot).toBe(true);
    expect(idsOf(1)).toEqual(["a"]);
    expect((await store.getState()).needsFullSnapshot).toBe(false);
    expect((await store.getState()).status).toBe("ok");
  });
});

describe("requests the server cannot accept", () => {
  it("halves a batch that is too large (413) until it fits, delivering every event once, in order", async () => {
    const all = Array.from({ length: 100 }, (_, i) => `e${String(i).padStart(3, "0")}`);
    await store.apply({ events: all.map(ev) });
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string) as IngestBatchRequest;
      return body.events.length > 40 ? status(413) : ok();
    });

    expect(await sender().drainOnce()).toMatchObject({ outcome: "sent" });

    // 100 is too big; 50 is too big; 25 fits (twice); the second 50 is halved the same way.
    expect(fetchMock.mock.calls.map((_, i) => bodyOf(i).events.length)).toEqual([100, 50, 25, 25, 50, 25, 25]);
    // The requests the server accepted, in the order they were sent, cover every event once.
    const accepted = fetchMock.mock.calls
      .map((_, i) => idsOf(i))
      .filter((ids) => ids.length <= 40)
      .flat();
    expect(accepted).toEqual(all);
    expect(await queuedIds()).toEqual([]);
  });

  it("isolates one invalid event (400), quarantines only that event, and delivers the rest", async () => {
    await store.apply({ events: [ev("e1"), ev("bad"), ev("e3"), ev("e4")] });
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string) as IngestBatchRequest;
      return body.events.some((e) => e.id === "bad") ? status(400) : ok();
    });

    expect(await sender().drainOnce()).toMatchObject({ outcome: "sent" });
    const acceptedIds = fetchMock.mock.calls
      .map((_, i) => idsOf(i))
      .filter((ids) => !ids.includes("bad"))
      .flat();
    expect(acceptedIds).toEqual(["e1", "e3", "e4"]);
    expect(await queuedIds()).toEqual([]); // the bad one is gone from the queue, not stuck at its head
    const state = await store.getState();
    expect(state.quarantinedInvalid).toBe(1);
    expect(state.status).toBe("ok");
  });

  it("treats 422 the same way", async () => {
    await store.apply({ events: [ev("bad")] });
    fetchMock.mockResolvedValue(status(422));
    await sender().drainOnce();
    expect(await queuedIds()).toEqual([]);
    expect((await store.getState()).quarantinedInvalid).toBe(1);
  });

  it("keeps a valid event when the snapshots sent with it are what the server rejected", async () => {
    await store.apply({ events: [ev("a")], dirty: [{ tabId: 1, snapshot: snap(1), ready: true }] });
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string) as IngestBatchRequest;
      return body.tabs.length > 0 ? status(400) : ok();
    });

    await sender().drainOnce();
    const acceptedEvents = fetchMock.mock.calls
      .map((_, i) => bodyOf(i))
      .filter((b) => b.tabs.length === 0)
      .flatMap((b) => b.events.map((e) => e.id));
    expect(acceptedEvents).toEqual(["a"]);
    expect(await queuedIds()).toEqual([]);
    expect(await store.listDirty()).toEqual([]); // the rejected snapshot is quarantined, not retried forever
    expect((await store.getState()).quarantinedInvalid).toBeGreaterThan(0);
  });

  it("does not loop on a full snapshot the server keeps rejecting", async () => {
    await store.updateState({ needsFullSnapshot: true });
    const takeFullSnapshot = async () => {
      await store.apply({ dirty: [{ tabId: 1, snapshot: snap(1), ready: true }] });
    };
    fetchMock.mockResolvedValue(status(400));
    await sender({ takeFullSnapshot }).drainOnce();
    expect((await store.getState()).needsFullSnapshot).toBe(false);
  });

  it("stops at the first transient failure while splitting, leaving the unsent events queued", async () => {
    await store.apply({ events: [ev("e1"), ev("bad"), ev("e3")] });
    let calls = 0;
    fetchMock.mockImplementation(async (_url, init) => {
      calls++;
      const body = JSON.parse(init!.body as string) as IngestBatchRequest;
      if (calls > 3) return status(503);
      return body.events.some((e) => e.id === "bad") ? status(400) : ok();
    });
    const result = await sender().drainOnce();
    expect(result.outcome).toBe("failed");
    expect((await queuedIds()).includes("e3")).toBe(true);
    expect((await store.getState()).status).toBe("retrying");
  });
});
