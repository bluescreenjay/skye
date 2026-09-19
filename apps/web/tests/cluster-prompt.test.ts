import { describe, expect, it } from "vitest";
import { buildRequest, stripUrl, validateAnswer } from "@/src/cluster/prompt";
import { ModelError } from "@/src/llm/errors";

const WS = [
  { id: "w1", name: "Trip to Japan" },
  { id: "w2", name: "Work" },
];

function candidates(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `uuid-${i + 1}`, url: `https://site${i + 1}.example/p`, title: `T${i + 1}`, snippet: `S${i + 1}` }));
}

/** An idMap for t1..tN pointing at uuid-1..uuid-N. */
function idMap(n: number) {
  return buildRequest(candidates(n), WS).idMap;
}

const g = (over: Record<string, unknown> = {}) => ({
  name: "Kyoto trip",
  emoji: "🗾",
  confidence: 0.9,
  existingWorkspaceId: null,
  tabIds: ["t1", "t2"],
  ...over,
});

describe("buildRequest: what leaves the server (FR-018)", () => {
  it("gives every tab a short id and keeps the map back to the tab-ref id", () => {
    const { input, idMap: map } = buildRequest(candidates(3), WS);
    expect(input.tabs.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(map.get("t2")).toBe("uuid-2");
  });

  it("sends only id, title, url and snippet for a tab, and only id and name for a workspace", () => {
    const { input } = buildRequest(
      [{ id: "uuid-1", url: "https://a.example/", title: "T", snippet: "S", extra: "should not travel", userId: "u1" } as never],
      [{ id: "w1", name: "W", status: "active", userId: "u1" } as never],
    );
    expect(Object.keys(input.tabs[0]).sort()).toEqual(["id", "snippet", "title", "url"]);
    expect(Object.keys(input.workspaces[0]).sort()).toEqual(["id", "name"]);
    expect(JSON.stringify(input)).not.toContain("uuid-1");
    expect(JSON.stringify(input)).not.toContain("u1");
  });

  it("cuts title to 200, url to 200, and snippet to 600 characters", () => {
    const { input } = buildRequest(
      [{ id: "a", url: `https://a.example/${"p".repeat(500)}`, title: "t".repeat(500), snippet: "s".repeat(2000) }],
      [],
    );
    expect(input.tabs[0].title).toHaveLength(200);
    expect(input.tabs[0].url).toHaveLength(200);
    expect(input.tabs[0].snippet).toHaveLength(600);
  });

  it("removes the query string and the fragment from every url", () => {
    expect(stripUrl("https://a.example/path?token=SECRET&x=1#frag")).toBe("https://a.example/path");
    expect(stripUrl("https://a.example/?session=abc")).toBe("https://a.example/");
    expect(stripUrl("https://a.example/#only-fragment")).toBe("https://a.example/");
    const { input } = buildRequest([{ id: "a", url: "https://a.example/x?email=me@example.com", title: "t", snippet: "s" }], []);
    expect(JSON.stringify(input)).not.toContain("email=");
    expect(JSON.stringify(input)).not.toContain("me@example.com");
  });

  it("still strips a url the URL parser rejects", () => {
    expect(stripUrl("not a url?secret=1#x")).toBe("not a url");
  });
});

describe("validateAnswer: the model's answer is never trusted (contracts/model.md)", () => {
  it("resolves short ids back to tab-ref ids", () => {
    const { groups, discarded } = validateAnswer({ groups: [g({ tabIds: ["t2", "t1"] })] }, idMap(3), WS);
    expect(discarded).toBe(0);
    expect(groups).toEqual([
      { name: "Kyoto trip", emoji: "🗾", confidence: 0.9, existingWorkspaceId: null, tabRefIds: ["uuid-2", "uuid-1"] },
    ]);
  });

  it("drops unknown and repeated tab ids", () => {
    const { groups } = validateAnswer({ groups: [g({ tabIds: ["t1", "t1", "t99", "t2", 7, null] })] }, idMap(3), WS);
    expect(groups[0].tabRefIds).toEqual(["uuid-1", "uuid-2"]);
  });

  it("gives a tab claimed by two groups to the more confident one", () => {
    const { groups } = validateAnswer(
      {
        groups: [
          g({ name: "Low", confidence: 0.6, tabIds: ["t1", "t2", "t3"] }),
          g({ name: "High", confidence: 0.95, tabIds: ["t3", "t4"] }),
        ],
      },
      idMap(4),
      WS,
    );
    expect(groups.map((x) => [x.name, x.tabRefIds])).toEqual([
      ["High", ["uuid-3", "uuid-4"]],
      ["Low", ["uuid-1", "uuid-2"]],
    ]);
  });

  it("discards a group left with fewer than 2 tabs, and counts it", () => {
    const answer = {
      groups: [g({ tabIds: ["t1"] }), g({ name: "Ok", tabIds: ["t2", "t3"] }), g({ name: "Stolen", confidence: 0.5, tabIds: ["t2", "t4"] })],
    };
    const { groups, discarded } = validateAnswer(answer, idMap(4), WS);
    expect(groups.map((x) => x.name)).toEqual(["Ok"]);
    expect(discarded).toBe(2); // the one-tab group, and the one whose tab t2 went to "Ok" (leaving t4 alone)
  });

  it("discards a group whose confidence is not a number between 0 and 1", () => {
    for (const confidence of [NaN, Infinity, -0.1, 1.2, "0.9", null, undefined]) {
      const { groups, discarded } = validateAnswer({ groups: [g({ confidence })] }, idMap(2), WS);
      expect(groups).toEqual([]);
      expect(discarded).toBe(1);
    }
    expect(validateAnswer({ groups: [g({ confidence: 0 })] }, idMap(2), WS).groups).toHaveLength(1);
    expect(validateAnswer({ groups: [g({ confidence: 1 })] }, idMap(2), WS).groups).toHaveLength(1);
  });

  it("discards blank, over-long, reserved, and generic names", () => {
    const bad = ["", "   ", "x".repeat(81), "Other", "  other  ", "OTHER", "Group 3", "group", "Cluster 2", "Untitled", "Miscellaneous", "Misc", "Tabs", 42, null];
    for (const name of bad) {
      const { groups, discarded } = validateAnswer({ groups: [g({ name })] }, idMap(2), WS);
      expect(groups, String(name)).toEqual([]);
      expect(discarded, String(name)).toBe(1);
    }
  });

  it("trims a good name and accepts one of exactly 80 characters", () => {
    expect(validateAnswer({ groups: [g({ name: "  Kyoto trip  " })] }, idMap(2), WS).groups[0].name).toBe("Kyoto trip");
    expect(validateAnswer({ groups: [g({ name: "x".repeat(80) })] }, idMap(2), WS).groups).toHaveLength(1);
  });

  it("keeps an existingWorkspaceId only if the server sent it", () => {
    expect(validateAnswer({ groups: [g({ existingWorkspaceId: "w1" })] }, idMap(2), WS).groups[0].existingWorkspaceId).toBe("w1");
    expect(validateAnswer({ groups: [g({ existingWorkspaceId: "invented" })] }, idMap(2), WS).groups[0].existingWorkspaceId).toBeNull();
    expect(validateAnswer({ groups: [g({ existingWorkspaceId: 5 })] }, idMap(2), WS).groups[0].existingWorkspaceId).toBeNull();
  });

  it("keeps a short emoji and nulls anything else", () => {
    expect(validateAnswer({ groups: [g({ emoji: "🗾" })] }, idMap(2), WS).groups[0].emoji).toBe("🗾");
    for (const emoji of ["", "   ", "a long sentence instead of an emoji", 7, null, undefined]) {
      expect(validateAnswer({ groups: [g({ emoji })] }, idMap(2), WS).groups[0].emoji).toBeNull();
    }
  });

  it("discards a group that is not an object", () => {
    const { groups, discarded } = validateAnswer({ groups: ["nope", 3, null, [], g()] }, idMap(2), WS);
    expect(groups).toHaveLength(1);
    expect(discarded).toBe(4);
  });

  it("treats an empty groups array as a valid answer with nothing found", () => {
    expect(validateAnswer({ groups: [] }, idMap(2), WS)).toEqual({ groups: [], discarded: 0 });
  });

  it("throws ModelError when the top level is not an object with a groups array", () => {
    for (const answer of [null, undefined, "text", 5, [], {}, { groups: "x" }, { groups: null }, { group: [] }]) {
      expect(() => validateAnswer(answer, idMap(2), WS), JSON.stringify(answer)).toThrow(ModelError);
    }
  });
});

describe("confidenceBar", () => {
  it("defaults to 0.7, honours a valid CLUSTER_CONFIDENCE_BAR, and ignores a bad one", async () => {
    const { confidenceBar } = await import("@/src/cluster/model");
    const saved = process.env.CLUSTER_CONFIDENCE_BAR;
    try {
      delete process.env.CLUSTER_CONFIDENCE_BAR;
      expect(confidenceBar()).toBe(0.7);
      process.env.CLUSTER_CONFIDENCE_BAR = "0.97";
      expect(confidenceBar()).toBe(0.97);
      for (const bad of ["", "abc", "1.5", "-0.1"]) {
        process.env.CLUSTER_CONFIDENCE_BAR = bad;
        expect(confidenceBar(), bad).toBe(0.7);
      }
    } finally {
      if (saved === undefined) delete process.env.CLUSTER_CONFIDENCE_BAR;
      else process.env.CLUSTER_CONFIDENCE_BAR = saved;
    }
  });
});
