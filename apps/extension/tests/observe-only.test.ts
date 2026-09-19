import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollector } from "../src/collector";
import { createSnapshotter } from "../src/snapshot";
import { createStore, type Store } from "../src/store";
import { installChromeMock, type ChromeMock, type MockTab } from "./helpers/chrome-mock";

const SRC = join(__dirname, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      // Home and Sidebar are product UI surfaces; ingest modules stay observe-only.
      if (entry.name === "home" || entry.name === "sidebar") return [];
      return sourceFiles(join(dir, entry.name));
    }
    return entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [];
  });
}

describe("the extension only observes: no call can change the browser's tabs or windows", () => {
  const files = sourceFiles(SRC);
  const ingestFiles = files.filter((file) => !file.endsWith("background.ts"));

  it("finds the source files it is meant to check", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  // Any call that would move, group, rename, close, or otherwise act on a tab or window.
  // chrome.tabs.create is allowed in background.ts so the toolbar can open Home.
  const forbidden = [
    /chrome\.tabs\.(update|move|remove|group|ungroup|duplicate|discard|reload|goBack|goForward|highlight|setZoom|executeScript|insertCSS|captureVisibleTab)\b/,
    /chrome\.tabGroups\b/,
    /chrome\.windows\.(create|update|remove)\b/,
    /chrome\.sidePanel\b/,
    /chrome\.(bookmarks|history|cookies|webRequest|webNavigation|downloads|management)\b/,
    /chrome\.scripting\.(insertCSS|removeCSS|registerContentScripts)\b/,
  ];

  it.each(forbidden.map((re) => [String(re), re] as const))("no source file matches %s", (_name, re) => {
    for (const file of files) {
      if (re.source.includes("sidePanel") && file.endsWith("sidepanel-gate.ts")) continue;
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(re);
    }
  });

  it("ingest modules still do not create tabs", () => {
    for (const file of ingestFiles) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/chrome\.tabs\.create\b/);
    }
  });

  it("does read pages, but only through scripting.executeScript with the page-text reader", () => {
    const uses = files.filter((f) => /chrome\.scripting\.executeScript/.test(readFileSync(f, "utf8")));
    expect(uses.map((f) => f.split("/").pop())).toEqual(["snippet.ts"]);
  });

  it("ingest modules have no HTML, popup, or DOM building", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/document\.(createElement|write|body\.append)|innerHTML\s*=|new Notification|chrome\.notifications/);
    }
  });
});

describe("no tab identity is invented or kept beyond what the design allows (FR-017)", () => {
  let mock: ChromeMock;
  let store: Store;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-19T10:00:00.000Z"));
    mock = installChromeMock();
    store = createStore({ now: () => Date.now() });
  });
  afterEach(() => vi.useRealTimers());

  const page = (id: number, over: Partial<MockTab> = {}): MockTab => ({
    id,
    windowId: 1,
    url: `https://example.com/${id}`,
    title: `Page ${id}`,
    active: id === 1,
    ...over,
  });

  it("stores only events, pending snapshots, the tracked-tab mirror, snippets, and sync state", async () => {
    const collector = createCollector({ store, now: () => Date.now() });
    const snapshotter = createSnapshotter({ store, now: () => Date.now() });
    mock.tabs = [page(1), page(2)];
    await snapshotter.reconcile(mock.tabs);
    await collector.onTabCreated(page(3));
    await collector.onTabActivated({ tabId: 2, windowId: 1 });
    await collector.onTabRemoved(2);
    await vi.advanceTimersByTimeAsync(3000);
    await store.updateState({ status: "ok" });

    const allowed = [/^v1:ev:\d+$/, /^v1:meta$/, /^v1:dirty:\d+$/, /^v1:dirty:ids$/, /^v1:mirror$/, /^v1:snip:\d+$/, /^v1:state$/];
    for (const key of mock.storage.keys()) {
      expect(allowed.some((re) => re.test(key)), `unexpected storage key ${key}`).toBe(true);
    }
  });

  it("keeps in the mirror only address, title, window, and last-seen time, keyed by browser tab id", async () => {
    const snapshotter = createSnapshotter({ store, now: () => Date.now() });
    await snapshotter.reconcile([page(1), page(2)]);
    const mirror = mock.storage.get("v1:mirror") as Record<string, Record<string, unknown>>;
    expect(Object.keys(mirror).sort()).toEqual(["1", "2"]);
    for (const entry of Object.values(mirror)) {
      expect(Object.keys(entry).sort()).toEqual(["lastSeenAt", "title", "url", "windowId"]);
    }
  });

  it("gives events and snapshots only the fields of the ingest contract, with no workspace or user", async () => {
    const snapshotter = createSnapshotter({ store, now: () => Date.now() });
    await snapshotter.reconcile([page(1)]);
    const { events, dirty } = await store.readBatch(100);
    expect(Object.keys(events[0].event).sort()).toEqual(["chromeTabId", "eventType", "id", "time", "title", "url"]);
    expect(Object.keys(dirty[0].entry.snapshot).sort()).toEqual([
      "active",
      "chromeTabId",
      "lastSeenAt",
      "snippet",
      "title",
      "url",
      "windowId",
    ]);
    const everything = JSON.stringify([...mock.storage.values()]);
    expect(everything).not.toMatch(/workspace|userId|tabRefId/i);
  });

  it("forgets everything about a tab from an earlier browser session on start", async () => {
    const snapshotter = createSnapshotter({ store, now: () => Date.now() });
    await snapshotter.reconcile([page(1), page(2)]);
    await snapshotter.resetForBrowserStart();
    expect((await store.getMirror()).size).toBe(0);
    expect(await store.listDirty()).toEqual([]);
    expect(await store.getSnippet(1)).toBeUndefined();
  });
});
