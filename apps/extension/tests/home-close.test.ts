import { describe, expect, it, vi, afterEach } from "vitest";
import type { TabRef, Workspace } from "@ai-browser/shared";
import { createCloseInFlight } from "../src/home/close-inflight";
import {
  composeDirectory,
  dropTabByChromeTabId,
  dropTabById,
  moveTabRef,
} from "../src/home/compose";
import { closeHomeTab } from "../src/home/navigation";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function workspace(partial: Partial<Workspace> & Pick<Workspace, "id" | "name">): Workspace {
  return {
    userId: "user-1",
    emoji: null,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function tab(partial: Partial<TabRef> & Pick<TabRef, "id" | "title" | "workspaceId">): TabRef {
  return {
    userId: "user-1",
    url: `https://example.com/${partial.id}`,
    snippet: "",
    chromeTabId: 1,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    placementSource: null,
    ...partial,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Home close — live filter pipeline", () => {
  it("hides closed members while keeping empty workspace cards", () => {
    const directory = composeDirectory(
      [workspace({ id: "w1", name: "resumes" }), workspace({ id: "w2", name: "quiet" })],
      [
        tab({ id: "a", title: "live a", workspaceId: "w1", chromeTabId: 10 }),
        tab({ id: "b", title: "closed b", workspaceId: "w1", chromeTabId: null }),
        tab({ id: "c", title: "other live", workspaceId: null, chromeTabId: 11 }),
        tab({ id: "d", title: "other closed", workspaceId: null, chromeTabId: null }),
      ],
    );

    expect(directory.cards.map((c) => c.workspace.id)).toEqual(["w1", "w2"]);
    expect(directory.cards[0]?.tabs.map((t) => t.id)).toEqual(["a"]);
    expect(directory.cards[1]?.tabs).toEqual([]);
    expect(directory.other.map((t) => t.id)).toEqual(["c"]);
  });

  it("optimistic drop by id then onRemoved by chrome id is idempotent", () => {
    const start = composeDirectory(
      [workspace({ id: "w1", name: "resumes" })],
      [
        tab({ id: "a", title: "doc", workspaceId: "w1", chromeTabId: 10 }),
        tab({ id: "b", title: "other", workspaceId: null, chromeTabId: 11 }),
      ],
    );

    const afterX = dropTabById(start, "a");
    expect(afterX.cards[0]?.tabs).toEqual([]);
    expect(afterX.other.map((t) => t.id)).toEqual(["b"]);

    const afterRemoved = dropTabByChromeTabId(afterX, 10);
    expect(afterRemoved).toEqual(afterX);

    const again = dropTabById(afterRemoved, "a");
    expect(again).toEqual(afterRemoved);
  });

  it("onRemoved alone clears Other and card rows for that chrome id", () => {
    const start = composeDirectory(
      [workspace({ id: "w1", name: "resumes" })],
      [
        tab({ id: "a", title: "doc", workspaceId: "w1", chromeTabId: 10 }),
        tab({ id: "b", title: "loose", workspaceId: null, chromeTabId: 11 }),
      ],
    );

    const after = dropTabByChromeTabId(start, 11);
    expect(after.other).toEqual([]);
    expect(after.cards[0]?.tabs.map((t) => t.id)).toEqual(["a"]);
  });

  it("refresh that still returns a live chromeTabId can resurrect a row (no preempt suppress)", () => {
    const start = composeDirectory(
      [workspace({ id: "w1", name: "resumes" })],
      [tab({ id: "a", title: "doc", workspaceId: "w1", chromeTabId: 10 })],
    );
    const hidden = dropTabById(start, "a");
    expect(hidden.cards[0]?.tabs).toEqual([]);

    // Simulate organize/refresh before ingest cleared the binding.
    const refreshed = composeDirectory(
      [workspace({ id: "w1", name: "resumes" })],
      [tab({ id: "a", title: "doc", workspaceId: "w1", chromeTabId: 10 })],
    );
    expect(refreshed.cards[0]?.tabs.map((t) => t.id)).toEqual(["a"]);
  });

  it("refresh after ingest cleared chromeTabId keeps the row hidden", () => {
    const refreshed = composeDirectory(
      [workspace({ id: "w1", name: "resumes" })],
      [tab({ id: "a", title: "doc", workspaceId: "w1", chromeTabId: null })],
    );
    expect(refreshed.cards[0]?.tabs).toEqual([]);
    expect(refreshed.cards).toHaveLength(1);
  });

  it("moveTabRef only reshuffles currently visible live tabs", () => {
    const start = composeDirectory(
      [workspace({ id: "w1", name: "a" }), workspace({ id: "w2", name: "b" })],
      [
        tab({ id: "live", title: "open", workspaceId: "w1", chromeTabId: 1 }),
        tab({ id: "closed", title: "saved", workspaceId: "w1", chromeTabId: null }),
      ],
    );
    expect(start.cards[0]?.tabs.map((t) => t.id)).toEqual(["live"]);

    const moved = moveTabRef(start, "live", "w2");
    expect(moved.cards.find((c) => c.workspace.id === "w1")?.tabs).toEqual([]);
    expect(moved.cards.find((c) => c.workspace.id === "w2")?.tabs.map((t) => t.id)).toEqual(["live"]);
  });
});

describe("createCloseInFlight", () => {
  it("rejects a second begin until end", () => {
    const gate = createCloseInFlight();
    expect(gate.begin("t1")).toBe(true);
    expect(gate.begin("t1")).toBe(false);
    expect(gate.has("t1")).toBe(true);
    gate.end("t1");
    expect(gate.begin("t1")).toBe(true);
  });

  it("tracks ids independently", () => {
    const gate = createCloseInFlight();
    expect(gate.begin("a")).toBe(true);
    expect(gate.begin("b")).toBe(true);
    expect(gate.begin("a")).toBe(false);
    gate.end("a");
    expect(gate.begin("a")).toBe(true);
    expect(gate.begin("b")).toBe(false);
  });
});

describe("closeHomeTab edge cases", () => {
  it("no-ops for incognito live tabs without calling remove", async () => {
    const remove = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 42,
          url: "https://example.com/t1",
          incognito: true,
        }),
        remove,
      },
    });

    await expect(
      closeHomeTab(tab({ id: "t1", title: "x", workspaceId: "w1", chromeTabId: 42 })),
    ).resolves.toBe("noop");
    expect(remove).not.toHaveBeenCalled();
  });

  it("returns closed when remove rejects after a matching get", async () => {
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 42,
          url: "https://example.com/t1",
          incognito: false,
        }),
        remove: vi.fn().mockRejectedValue(new Error("Tabs cannot be edited right now")),
      },
    });

    await expect(
      closeHomeTab(tab({ id: "t1", title: "x", workspaceId: "w1", chromeTabId: 42, url: "https://example.com/t1" })),
    ).resolves.toBe("closed");
  });

  it("parallel closes without the Home gate may both call remove", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 42,
          url: "https://example.com/t1",
          incognito: false,
        }),
        remove,
      },
    });
    const ref = tab({
      id: "t1",
      title: "x",
      workspaceId: "w1",
      chromeTabId: 42,
      url: "https://example.com/t1",
    });

    await Promise.all([closeHomeTab(ref), closeHomeTab(ref)]);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("Home gate + closeHomeTab only removes once for double begin", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 42,
          url: "https://example.com/t1",
          incognito: false,
        }),
        remove,
      },
    });
    const ref = tab({
      id: "t1",
      title: "x",
      workspaceId: "w1",
      chromeTabId: 42,
      url: "https://example.com/t1",
    });
    const gate = createCloseInFlight();

    const run = async () => {
      if (!gate.begin(ref.id)) return "skipped";
      try {
        return await closeHomeTab(ref);
      } finally {
        gate.end(ref.id);
      }
    };

    const results = await Promise.all([run(), run()]);
    expect(results.filter((r) => r === "skipped")).toHaveLength(1);
    expect(results.filter((r) => r === "closed")).toHaveLength(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe("observe-only boundary for close", () => {
  it("allows chrome.tabs.remove only under home/ (product UI)", () => {
    const homeNav = readFileSync(join(__dirname, "../src/home/navigation.ts"), "utf8");
    expect(homeNav).toMatch(/chrome\.tabs\.remove/);

    const collector = readFileSync(join(__dirname, "../src/collector.ts"), "utf8");
    expect(collector).not.toMatch(/chrome\.tabs\.remove/);
  });
});
