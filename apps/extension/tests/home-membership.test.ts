import { describe, expect, it } from "vitest";
import type { TabRef, Workspace } from "@ai-browser/shared";
import { composeDirectory, moveTabRef } from "../src/home/compose";

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

function tab(id: string, title: string, workspaceId: string | null): TabRef {
  return {
    id,
    userId: "user-1",
    workspaceId,
    url: `https://example.com/${id}`,
    title,
    snippet: "",
    chromeTabId: null,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    placementSource: null,
  };
}

describe("moveTabRef membership", () => {
  it("moves a workspace tab to Other and back without dummy seed data", () => {
    const start = composeDirectory(
      [workspace("w1", "hackathon")],
      [tab("t1", "docs", "w1"), tab("t2", "loose", null)],
    );

    const toOther = moveTabRef(start, "t1", null);
    expect(toOther.other.map((item) => item.id).sort()).toEqual(["t1", "t2"]);
    expect(toOther.cards[0]?.tabs).toEqual([]);
    expect(toOther.cards[0]?.workspace.name).toBe("hackathon");
    expect(toOther.cards.some((card) => card.workspace.name === "other")).toBe(false);

    const back = moveTabRef(toOther, "t1", "w1");
    expect(back.other.map((item) => item.id)).toEqual(["t2"]);
    expect(back.cards[0]?.tabs.map((item) => item.id)).toEqual(["t1"]);

    const names = back.cards.map((card) => card.workspace.name);
    expect(names).not.toContain("refs — furniture");
  });
});
