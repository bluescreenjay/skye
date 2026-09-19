import { describe, expect, it } from "vitest";
import type { TabRef, Workspace } from "@ai-browser/shared";
import { composeDirectory, dropTabByChromeTabId, dropTabById } from "../src/home/compose";

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
    url: "https://example.com",
    snippet: "",
    chromeTabId: 1,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    placementSource: null,
    ...partial,
  };
}

describe("composeDirectory", () => {
  it("puts workspaceId-null tabs in Other and named workspaces in cards", () => {
    const workspaces = [workspace({ id: "w1", name: "hackathon" })];
    const tabRefs = [
      tab({ id: "t1", title: "docs", workspaceId: "w1", chromeTabId: 11 }),
      tab({ id: "t2", title: "loose", workspaceId: null, chromeTabId: 12 }),
    ];
    const directory = composeDirectory(workspaces, tabRefs);
    expect(directory.other.map((item) => item.id)).toEqual(["t2"]);
    expect(directory.cards).toHaveLength(1);
    expect(directory.cards[0]?.workspace.name).toBe("hackathon");
    expect(directory.cards[0]?.tabs.map((item) => item.id)).toEqual(["t1"]);
    expect(directory.cards.some((card) => /other|ungrouped/i.test(card.workspace.name))).toBe(false);
  });

  it("omits closed tabs (chromeTabId null) from Other and cards", () => {
    const directory = composeDirectory(
      [workspace({ id: "w1", name: "hackathon" })],
      [
        tab({ id: "live", title: "open", workspaceId: "w1", chromeTabId: 5 }),
        tab({ id: "closed", title: "gone", workspaceId: "w1", chromeTabId: null }),
        tab({ id: "other-closed", title: "also gone", workspaceId: null, chromeTabId: null }),
      ],
    );
    expect(directory.cards[0]?.tabs.map((item) => item.id)).toEqual(["live"]);
    expect(directory.other).toEqual([]);
  });

  it("still lists a named workspace with zero tabs", () => {
    const directory = composeDirectory([workspace({ id: "empty", name: "saved pile" })], []);
    expect(directory.cards).toHaveLength(1);
    expect(directory.cards[0]?.tabs).toEqual([]);
    expect(directory.other).toEqual([]);
  });

  it("omits archived workspaces", () => {
    const directory = composeDirectory(
      [workspace({ id: "gone", name: "old", status: "archived" }), workspace({ id: "live", name: "now" })],
      [tab({ id: "t1", title: "x", workspaceId: "gone", chromeTabId: 3 })],
    );
    expect(directory.cards.map((card) => card.workspace.id)).toEqual(["live"]);
  });

  it("never injects dummy seed names like refs — furniture", () => {
    const directory = composeDirectory([], []);
    const names = [
      ...directory.cards.map((card) => card.workspace.name),
      ...directory.other.map((item) => item.title),
    ];
    expect(names).not.toContain("refs — furniture");
    expect(names).not.toContain("ungrouped tabs");
    expect(directory.cards).toEqual([]);
    expect(directory.other).toEqual([]);
  });
});

describe("dropTab helpers", () => {
  it("drops by TabRef id and by chrome tab id", () => {
    const start = composeDirectory(
      [workspace({ id: "w1", name: "hackathon" })],
      [
        tab({ id: "t1", title: "docs", workspaceId: "w1", chromeTabId: 11 }),
        tab({ id: "t2", title: "loose", workspaceId: null, chromeTabId: 12 }),
      ],
    );
    expect(dropTabById(start, "t1").cards[0]?.tabs).toEqual([]);
    expect(dropTabByChromeTabId(start, 12).other).toEqual([]);
  });
});
