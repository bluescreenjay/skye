import { describe, expect, it } from "vitest";
import type { TabRef, Workspace } from "@ai-browser/shared";
import { composeDirectory, emptiedWorkspaceIds, moveTabRef } from "../src/home/compose";

function workspace(id: string, name: string): Workspace {
  return {
    id,
    userId: "user-1",
    name,
    emoji: null,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function tab(id: string, title: string, workspaceId: string | null, chromeTabId = 1): TabRef {
  return {
    id,
    userId: "user-1",
    workspaceId,
    url: `https://example.com/${id}`,
    title,
    snippet: "",
    chromeTabId,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    placementSource: null,
  };
}

describe("moveTabRef membership", () => {
  it("moves a workspace tab to Other and back without dummy seed data", () => {
    const start = composeDirectory(
      [workspace("w1", "hackathon"), workspace("w2", "cooking")],
      [tab("t1", "docs", "w1", 11), tab("t2", "loose", null, 12), tab("t3", "recipe", "w2", 13)],
    );

    // Move one of two live tabs out of cooking → card stays with the other tab.
    const toCookingOther = moveTabRef(start, "t3", null);
    expect(toCookingOther.other.map((item) => item.id).sort()).toEqual(["t2", "t3"]);
    expect(toCookingOther.cards.find((c) => c.workspace.id === "w2")).toBeUndefined();
    expect(emptiedWorkspaceIds(start, toCookingOther)).toEqual(["w2"]);

    // Move docs to cooking's sibling workspace that still has a card (hackathon stays).
    const toHack = moveTabRef(start, "t2", "w1");
    expect(toHack.other).toEqual([]);
    expect(toHack.cards.find((c) => c.workspace.id === "w1")?.tabs.map((t) => t.id).sort()).toEqual(["t1", "t2"]);

    // Last live tab out of hackathon: card is omitted (archive on empty); no "other" workspace card.
    const emptied = moveTabRef(start, "t1", null);
    expect(emptied.other.map((item) => item.id).sort()).toEqual(["t1", "t2"]);
    expect(emptied.cards.map((c) => c.workspace.id)).toEqual(["w2"]);
    expect(emptied.cards.some((card) => card.workspace.name === "other")).toBe(false);
    expect(emptiedWorkspaceIds(start, emptied)).toEqual(["w1"]);

    const names = emptied.cards.map((card) => card.workspace.name);
    expect(names).not.toContain("refs — furniture");
  });
});
