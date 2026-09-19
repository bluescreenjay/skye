import { SNIPPET_MAX_LENGTH } from "@ai-browser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollector } from "../src/collector";
import { captureSnippet, mapLimit, normalizeSnippet, readPageText, resolveSnippet } from "../src/snippet";
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

const page = (id: number, over: Partial<MockTab> = {}): MockTab => ({
  id,
  windowId: 1,
  url: `https://example.com/${id}`,
  title: `Page ${id}`,
  active: false,
  status: "complete",
  ...over,
});

describe("normalizeSnippet", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeSnippet("  Hello \n\n  world\t!  ")).toBe("Hello world !");
  });

  it("cuts to the size limit", () => {
    const text = normalizeSnippet("a".repeat(SNIPPET_MAX_LENGTH * 3));
    expect(text).toHaveLength(SNIPPET_MAX_LENGTH);
  });

  it("does not cut text that already fits", () => {
    const text = "word ".repeat(100).trim();
    expect(normalizeSnippet(text)).toBe(text);
  });

  it("returns page text as it is, never interpreting or stripping it", () => {
    expect(normalizeSnippet("Use <div> and <script> tags")).toBe("Use <div> and <script> tags");
  });

  it.each([undefined, null, 42, {}, ["a"]])("returns an empty snippet for a non-string result: %j", (value) => {
    expect(normalizeSnippet(value)).toBe("");
  });
});

describe("readPageText (runs inside the page)", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).document;
  });

  it("returns the page's visible text, bounded so huge pages are not shipped whole", () => {
    (globalThis as Record<string, unknown>).document = { body: { innerText: "x".repeat(50_000) } };
    const text = readPageText();
    expect(text.length).toBeGreaterThan(SNIPPET_MAX_LENGTH);
    expect(text.length).toBeLessThan(50_000);
  });

  it("returns an empty string when the page has no body", () => {
    (globalThis as Record<string, unknown>).document = { body: null };
    expect(readPageText()).toBe("");
  });
});

describe("captureSnippet", () => {
  it("returns the normalised page text", async () => {
    mock.scriptResults.set(1, "  An   article \n about things ");
    expect(await captureSnippet(1)).toBe("An article about things");
  });

  it("returns an empty snippet when the script cannot run (restricted page, closed tab)", async () => {
    mock.scriptResults.set(1, new Error("Cannot access contents of the page."));
    expect(await captureSnippet(1)).toBe("");
  });

  it("returns an empty snippet when the page gave no text", async () => {
    expect(await captureSnippet(1)).toBe("");
  });
});

describe("resolveSnippet: when to read the page", () => {
  const capture = (text: string) => vi.fn(async () => text);

  it("reads the page when nothing is cached, and asks for the result to be cached", async () => {
    const c = capture("Fresh text");
    const result = await resolveSnippet({ store, capture: c }, page(1), 1, "https://example.com/1");
    expect(result).toEqual({ text: "Fresh text", cache: { url: "https://example.com/1", text: "Fresh text" } });
    expect(c).toHaveBeenCalledTimes(1);
  });

  it("reuses the cached snippet when the address has not changed", async () => {
    await store.apply({ snippets: { 1: { url: "https://example.com/1", text: "Cached" } } });
    const c = capture("Fresh");
    const result = await resolveSnippet({ store, capture: c }, page(1), 1, "https://example.com/1");
    expect(result).toEqual({ text: "Cached" });
    expect(c).not.toHaveBeenCalled();
  });

  it("reads again when the address changed", async () => {
    await store.apply({ snippets: { 1: { url: "https://example.com/old", text: "Old page" } } });
    const c = capture("New page");
    const result = await resolveSnippet({ store, capture: c }, page(1), 1, "https://example.com/1");
    expect(result.text).toBe("New page");
    expect(c).toHaveBeenCalledTimes(1);
  });

  it("tries again when the last attempt found no text (a page that had not rendered yet)", async () => {
    await store.apply({ snippets: { 1: { url: "https://example.com/1", text: "" } } });
    const c = capture("Now rendered");
    expect((await resolveSnippet({ store, capture: c }, page(1), 1, "https://example.com/1")).text).toBe("Now rendered");
  });

  it("does not read a page that is still loading; an old page's snippet is not reused for a new address", async () => {
    await store.apply({ snippets: { 1: { url: "https://example.com/old", text: "Old page" } } });
    const c = capture("Loading text");
    const result = await resolveSnippet({ store, capture: c }, page(1, { status: "loading" }), 1, "https://example.com/1");
    expect(result).toEqual({ text: "" });
    expect(c).not.toHaveBeenCalled();
  });

  it("keeps the cached snippet for a page that reloads at the same address", async () => {
    await store.apply({ snippets: { 1: { url: "https://example.com/1", text: "Cached" } } });
    const c = capture("x");
    const result = await resolveSnippet({ store, capture: c }, page(1, { status: "loading" }), 1, "https://example.com/1");
    expect(result.text).toBe("Cached");
    expect(c).not.toHaveBeenCalled();
  });

  it("does not read a discarded tab", async () => {
    const c = capture("x");
    const result = await resolveSnippet({ store, capture: c }, page(1, { discarded: true }), 1, "https://example.com/1");
    expect(result).toEqual({ text: "" });
    expect(c).not.toHaveBeenCalled();
  });

  it("reads a tab whose load status is not reported", async () => {
    const c = capture("Text");
    const tab = page(1);
    delete tab.status;
    expect((await resolveSnippet({ store, capture: c }, tab, 1, "https://example.com/1")).text).toBe("Text");
  });
});

describe("snippets in reported tabs", () => {
  const collector = () => createCollector({ store, now: () => Date.now() });
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const setTab = (tab: MockTab) => {
    const i = mock.tabs.findIndex((t) => t.id === tab.id);
    if (i >= 0) mock.tabs[i] = tab;
    else mock.tabs.push(tab);
  };

  it("puts the snippet in the snapshot and never in an event", async () => {
    mock.scriptResults.set(1, "A short article about the topic");
    const tab = page(1);
    setTab(tab);
    const c = collector();
    await c.onTabCreated(tab);
    await advance(2000);

    const batch = await store.readBatch(100);
    expect(batch.dirty[0].entry.snapshot.snippet).toBe("A short article about the topic");
    expect(JSON.stringify(batch.events)).not.toContain("short article");
  });

  it("reports the tab with an empty snippet when the page cannot be read", async () => {
    mock.scriptResults.set(1, new Error("Cannot access contents of the page."));
    const tab = page(1);
    setTab(tab);
    const c = collector();
    await c.onTabCreated(tab);
    await advance(2000);

    const batch = await store.readBatch(100);
    expect(batch.events.map((e) => e.event.eventType)).toEqual(["opened"]);
    expect(batch.dirty).toHaveLength(1);
    expect(batch.dirty[0].entry.snapshot.snippet).toBe("");
  });

  it("reads the page once per address, not on every title change", async () => {
    mock.scriptResults.set(1, "Body text");
    setTab(page(1));
    const c = collector();
    await c.onTabCreated(page(1));
    await advance(2000);
    expect(mock.scriptCalls).toEqual([1]);

    const retitled = page(1, { title: "New title" });
    setTab(retitled);
    await c.onTabUpdated(1, { title: "New title" }, retitled);
    await advance(2000);
    expect(mock.scriptCalls).toEqual([1]); // same address, snippet reused
    expect((await store.readBatch(100)).dirty[0].entry.snapshot.snippet).toBe("Body text");

    const moved = page(1, { url: "https://example.com/elsewhere" });
    setTab(moved);
    mock.scriptResults.set(1, "Other page text");
    await c.onTabUpdated(1, { url: moved.url }, moved);
    await advance(2000);
    expect(mock.scriptCalls).toEqual([1, 1]);
    expect((await store.readBatch(100)).dirty[0].entry.snapshot.snippet).toBe("Other page text");
  });

  it("forgets a tab's cached snippet when the tab closes", async () => {
    mock.scriptResults.set(1, "Body text");
    setTab(page(1));
    const c = collector();
    await c.onTabCreated(page(1));
    await advance(2000);
    expect(await store.getSnippet(1)).toEqual({ url: "https://example.com/1", text: "Body text" });
    await c.onTabRemoved(1);
    expect(await store.getSnippet(1)).toBeUndefined();
  });

  it("captures the snippet for every tab in a full snapshot, with at most 5 reads at once", async () => {
    let running = 0;
    let peak = 0;
    const capture = vi.fn(async (tabId: number) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running--;
      return `text ${tabId}`;
    });
    const tabs = Array.from({ length: 12 }, (_, i) => page(i + 1));
    const done = createSnapshotter({ store, now: () => Date.now(), captureSnippet: capture }).reconcile(tabs);
    await advance(500);
    await done;

    expect(capture).toHaveBeenCalledTimes(12);
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
    const { dirty } = await store.readBatch(100);
    expect(dirty).toHaveLength(12);
    expect(dirty.every((d) => d.entry.snapshot.snippet === `text ${d.tabId}`)).toBe(true);
  });

  it("does not block a full snapshot when some pages cannot be read", async () => {
    const capture = vi.fn(async (tabId: number) => {
      if (tabId % 2 === 0) throw new Error("blocked");
      return "ok";
    });
    await createSnapshotter({ store, now: () => Date.now(), captureSnippet: capture }).reconcile([page(1), page(2), page(3)]);
    const { dirty } = await store.readBatch(100);
    expect(dirty.map((d) => [d.tabId, d.entry.snapshot.snippet])).toEqual([[1, "ok"], [2, ""], [3, "ok"]]);
  });
});

describe("mapLimit", () => {
  it("keeps results in input order and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 6], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      for (let i = 0; i < n; i++) await Promise.resolve(); // yield a few times so tasks overlap
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 60]);
    expect(peak).toBe(2);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await mapLimit([], 5, async (n: number) => n)).toEqual([]);
    expect(await mapLimit([1, 2], 10, async (n) => n + 1)).toEqual([2, 3]);
  });
});
