import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollector } from "../src/collector";
import { createStore, type Store } from "../src/store";
import { installChromeMock, type ChromeMock, type MockTab } from "./helpers/chrome-mock";

const T0 = Date.parse("2026-09-19T10:00:00.000Z");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let mock: ChromeMock;
let store: Store;
let queued: number;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  mock = installChromeMock();
  store = createStore({ now: () => Date.now() });
  queued = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

const collector = (extra: Record<string, unknown> = {}) =>
  createCollector({ store, now: () => Date.now(), onQueued: () => void queued++, ...extra });

const setTab = (tab: MockTab) => {
  const i = mock.tabs.findIndex((t) => t.id === tab.id);
  if (i >= 0) mock.tabs[i] = tab;
  else mock.tabs.push(tab);
};
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
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

/** Creates a tab, lets it settle, and returns it, so tests start from a tracked tab. */
async function tracked(c: ReturnType<typeof collector>, tab: MockTab) {
  setTab(tab);
  await c.onTabCreated(tab);
  await advance(2000);
  return tab;
}

describe("opening tabs", () => {
  it("reports an eligible tab as opened immediately and its snapshot once it settles", async () => {
    const c = collector();
    const tab = page(1);
    setTab(tab);
    await c.onTabCreated(tab);

    expect(await kinds()).toEqual(["opened:1"]);
    expect(queued).toBeGreaterThan(0);
    expect((await store.readBatch(100)).dirty).toEqual([]); // still settling

    await advance(2000);
    const batch = await store.readBatch(100);
    expect(batch.dirty.map((d) => d.tabId)).toEqual([1]);
    expect(batch.events).toHaveLength(1); // nothing changed, so no extra event
  });

  it("reports a tab that starts on an internal page as opened when it first shows a web page", async () => {
    const c = collector();
    const start = page(2, { url: "chrome://newtab/", title: "New Tab" });
    setTab(start);
    await c.onTabCreated(start);
    expect(await kinds()).toEqual([]);

    const nav = page(2, { url: "https://example.com/b", title: "B" });
    setTab(nav);
    await c.onTabUpdated(2, { url: nav.url }, nav);
    expect(await kinds()).toEqual([]); // still settling

    await advance(2000);
    const [opened] = await events();
    expect(opened.eventType).toBe("opened");
    expect(opened.url).toBe("https://example.com/b");
    expect((await store.getMirror()).has(2)).toBe(true);
  });

  it("ignores tabs that are incognito or not web pages", async () => {
    const c = collector();
    for (const tab of [
      page(3, { incognito: true }),
      page(4, { url: "chrome://settings" }),
      page(5, { url: "file:///tmp/a.txt" }),
    ]) {
      setTab(tab);
      await c.onTabCreated(tab);
    }
    await advance(5000);
    expect(await events()).toEqual([]);
    expect((await store.getMirror()).size).toBe(0);
    expect(await store.listDirty()).toEqual([]);
  });
});

describe("updates", () => {
  it("coalesces a burst into one update carrying the final state, timed at the last change", async () => {
    const c = collector();
    await tracked(c, page(1, { title: "A" }));

    let lastChange = 0;
    for (const title of ["B", "C", "D"]) {
      lastChange = Date.now();
      const tab = page(1, { title });
      setTab(tab);
      await c.onTabUpdated(1, { title }, tab);
      await advance(500);
    }
    // Last change was 500 ms ago; the update is due 2 s after it.
    await advance(1499);
    expect(await kinds()).toEqual(["opened:1"]);
    await advance(1);

    const all = await events();
    expect(all.map((e) => e.eventType)).toEqual(["opened", "updated"]);
    expect(all[1].title).toBe("D");
    expect(all[1].time).toBe(new Date(lastChange).toISOString());
  });

  it("still reports a tab that never stops changing, no later than 30 s after its first change", async () => {
    const c = collector();
    await tracked(c, page(1, { title: "start" }));

    // A change every second for 30 s. Each change would restart the 2 s wait.
    for (let s = 0; s < 30; s++) {
      const tab = page(1, { title: `t${s}` });
      setTab(tab);
      await c.onTabUpdated(1, { title: tab.title }, tab);
      if (s < 29) await advance(1000);
    }
    // The first change was 29 s ago; the cap fires at 30 s.
    await advance(999);
    expect(await kinds()).toEqual(["opened:1"]);
    await advance(1);

    const updated = (await events()).filter((e) => e.eventType === "updated");
    expect(updated).toHaveLength(1);
    expect(updated[0].title).toBe("t29");
  });

  it("emits no event when only the load status changed, but still sends a fresh snapshot", async () => {
    const c = collector();
    const tab = await tracked(c, page(1));
    const first = (await store.readBatch(100)).dirty[0];
    await store.ackDirty(1, first.entry.lastChangeAt); // pretend it was delivered

    await c.onTabUpdated(1, { status: "complete" }, tab);
    await advance(2000);

    expect(await kinds()).toEqual(["opened:1"]);
    expect((await store.readBatch(100)).dirty.map((d) => d.tabId)).toEqual([1]);
  });

  it("ignores changes that are not about the address, title, or load status", async () => {
    const c = collector();
    const tab = await tracked(c, page(1));
    await store.readBatch(100);
    const before = await store.listDirty();
    await c.onTabUpdated(1, { audible: true } as never, tab);
    await advance(3000);
    expect(await store.listDirty()).toEqual(before);
  });
});

describe("closing tabs", () => {
  it("reports closed immediately with the last reported address and title", async () => {
    const c = collector();
    await tracked(c, page(1, { title: "Reported" }));
    await c.onTabRemoved(1);

    const all = await events();
    expect(all.map((e) => e.eventType)).toEqual(["opened", "closed"]);
    expect(all[1].url).toBe("https://example.com/1");
    expect(all[1].title).toBe("Reported");
    expect((await store.getMirror()).size).toBe(0);
    expect(await store.listDirty()).toEqual([]);
  });

  it("cancels the pending update of a tab that closes while settling", async () => {
    const c = collector();
    const tab = page(1);
    setTab(tab);
    await c.onTabCreated(tab);
    await c.onTabRemoved(1);
    mock.tabs = [];
    await advance(5000);
    expect(await kinds()).toEqual(["opened:1", "closed:1"]);
    expect(await store.listDirty()).toEqual([]);
  });

  it("reports nothing for a tab it never tracked", async () => {
    const c = collector();
    await c.onTabRemoved(99);
    expect(await events()).toEqual([]);
  });

  it("ends tracking, without revealing the new address, when a tab navigates to an internal page", async () => {
    const c = collector();
    await tracked(c, page(1));
    const settings = page(1, { url: "chrome://settings", title: "Settings" });
    setTab(settings);
    await c.onTabUpdated(1, { url: settings.url }, settings);

    const all = await events();
    expect(all.map((e) => e.eventType)).toEqual(["opened", "closed"]);
    expect(JSON.stringify(all)).not.toContain("chrome://");
    expect((await store.getMirror()).size).toBe(0);

    // Coming back to a web page starts tracking again.
    const back = page(1, { url: "https://example.com/again", title: "Again" });
    setTab(back);
    await c.onTabUpdated(1, { url: back.url }, back);
    await advance(2000);
    expect(await kinds()).toEqual(["opened:1", "closed:1", "opened:1"]);
  });

  it("treats a replaced tab as the old one closing and the new id opening", async () => {
    const c = collector();
    await tracked(c, page(1));
    mock.tabs = [page(2, { url: "https://example.com/prerendered", title: "Fast" })];
    await c.onTabReplaced(2, 1);

    expect(await kinds()).toEqual(["opened:1", "closed:1"]);
    await advance(2000);
    expect(await kinds()).toEqual(["opened:1", "closed:1", "opened:2"]);
  });
});

describe("ordering and identity", () => {
  it("queues events in the order they happened, each with a unique UUID", async () => {
    const c = collector();
    for (const id of [1, 2]) {
      const tab = page(id);
      setTab(tab);
      await c.onTabCreated(tab);
      await advance(10);
    }
    await c.onTabRemoved(1);

    const all = await events();
    expect(all.map((e) => `${e.eventType}:${e.chromeTabId}`)).toEqual(["opened:1", "opened:2", "closed:1"]);
    const times = all.map((e) => Date.parse(e.time));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    for (const e of all) expect(e.id).toMatch(UUID);
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
  });

  it("never puts a workspace, user, or snippet into an event", async () => {
    const c = collector();
    await tracked(c, page(1));
    const [event] = await events();
    expect(Object.keys(event).sort()).toEqual(["chromeTabId", "eventType", "id", "time", "title", "url"]);
  });
});

describe("worker restarts", () => {
  it("flushes an overdue update from persisted state after the timers are lost", async () => {
    const first = collector({ setTimer: () => 0 }); // simulates a worker that was stopped before its timers fired
    const tab = page(1, { title: "A" });
    setTab(tab);
    await first.onTabCreated(tab);
    const changed = page(1, { title: "B" });
    setTab(changed);
    await first.onTabUpdated(1, { title: "B" }, changed);

    const restarted = collector(); // a fresh worker: no in-memory timers at all
    vi.setSystemTime(T0 + 1000);
    expect(await restarted.flushDue()).toBe(0); // not settled yet

    vi.setSystemTime(T0 + 2500);
    expect(await restarted.flushDue()).toBe(1);
    expect(await kinds()).toEqual(["opened:1", "updated:1"]);
    expect((await store.readBatch(100)).dirty.map((d) => d.tabId)).toEqual([1]);
  });

  it("flushes a tab that has been changing for 30 s even though its last change is recent", async () => {
    const first = collector({ setTimer: () => 0 });
    const tab = page(1, { title: "A" });
    setTab(tab);
    await first.onTabCreated(tab);

    // Keep changing every second; the persisted entry keeps its original start.
    for (let s = 1; s <= 30; s++) {
      vi.setSystemTime(T0 + s * 1000);
      const next = page(1, { title: `t${s}` });
      setTab(next);
      await first.onTabUpdated(1, { title: next.title }, next);
    }

    const restarted = collector();
    vi.setSystemTime(T0 + 30_000); // last change was "now", but the wait began 30 s ago
    expect(await restarted.flushDue()).toBe(1);
    expect((await events()).some((e) => e.eventType === "updated" && e.title === "t30")).toBe(true);
  });
});

describe("handlers that run at the same moment", () => {
  it("reports a tab as opened once when the settle timer and the heartbeat flush it together", async () => {
    const c = collector({ setTimer: () => 0 }); // no timers: the two flushes are triggered by hand
    const start = page(2, { url: "chrome://newtab/", title: "New Tab" });
    setTab(start);
    await c.onTabCreated(start);
    const nav = page(2, { url: "https://example.com/b", title: "B" });
    setTab(nav);
    await c.onTabUpdated(2, { url: nav.url }, nav);

    vi.setSystemTime(T0 + 2500);
    await Promise.all([c.flushTab(2), c.flushDue()]);
    expect(await kinds()).toEqual(["opened:2"]);
  });

  it("reports a tab as opened once when it is created twice at the same moment", async () => {
    const c = collector();
    const tab = page(1);
    setTab(tab);
    await Promise.all([c.onTabCreated(tab), c.onTabCreated(tab)]);
    expect(await kinds()).toEqual(["opened:1"]);
  });

  it("reports a tab as opened once when its creation is handled while it is being flushed", async () => {
    const c = collector({ setTimer: () => 0 });
    const tab = page(3);
    setTab(tab);
    await c.onTabUpdated(3, { url: tab.url }, tab); // seen first through an update, so it is pending
    vi.setSystemTime(T0 + 2500);
    await Promise.all([c.onTabCreated(tab), c.flushTab(3)]);
    expect(await kinds()).toEqual(["opened:3"]);
  });

  it("does not flush a tab that was already flushed and has no newer change", async () => {
    const c = collector({ setTimer: () => 0 });
    const tab = page(4);
    setTab(tab);
    await c.onTabUpdated(4, { url: tab.url }, tab);
    vi.setSystemTime(T0 + 2500);
    await c.flushTab(4);
    const before = await store.listDirty();
    vi.setSystemTime(T0 + 5000);
    await c.flushTab(4); // a second flush with nothing new
    expect(await store.listDirty()).toEqual(before);
    expect(await kinds()).toEqual(["opened:4"]);
  });
});
