import { describe, expect, it } from "vitest";
import { scoreClusters } from "../scripts/score-lib.mjs";

const labels = {
  "https://a/1": "trip",
  "https://a/2": "trip",
  "https://a/3": "trip",
  "https://b/1": "code",
  "https://b/2": "code",
  "https://z/1": null, // a one-off
};

describe("scoreClusters (the one SC-001 scorer)", () => {
  it("scores a perfect result 100%", () => {
    const result = scoreClusters(labels, [], {
      "https://a/1": "W1", "https://a/2": "W1", "https://a/3": "W1",
      "https://b/1": "W2", "https://b/2": "W2",
      "https://z/1": null,
    });
    expect(result).toMatchObject({ percent: 100, correct: 6, total: 6, mismatches: [] });
  });

  it("does not care what the workspaces are called or which id each got", () => {
    const result = scoreClusters(labels, [], {
      "https://a/1": "zzz", "https://a/2": "zzz", "https://a/3": "zzz",
      "https://b/1": "aaa", "https://b/2": "aaa",
      "https://z/1": null,
    });
    expect(result.percent).toBe(100);
  });

  it("counts a tab in the wrong workspace, or a one-off that got placed, as wrong", () => {
    const result = scoreClusters(labels, [], {
      "https://a/1": "W1", "https://a/2": "W1", "https://a/3": "W2", // one trip tab strayed
      "https://b/1": "W2", "https://b/2": "W2",
      "https://z/1": "W1", // the one-off was forced into a workspace
    });
    expect(result.correct).toBe(4);
    expect(result.percent).toBeCloseTo(66.67, 1);
    expect(result.mismatches.map((m) => m.url).sort()).toEqual(["https://a/3", "https://z/1"]);
  });

  it("does not give credit for merging two topics into one workspace", () => {
    const result = scoreClusters(labels, [], {
      "https://a/1": "W1", "https://a/2": "W1", "https://a/3": "W1",
      "https://b/1": "W1", "https://b/2": "W1", // everything in one blob
      "https://z/1": null,
    });
    expect(result.correct).toBe(4); // the trip (3) plus the one-off; the code tabs are not credited
    expect(result.mismatches.map((m) => m.url).sort()).toEqual(["https://b/1", "https://b/2"]);
  });

  it("gives no credit to a topic the run left entirely in Other", () => {
    const result = scoreClusters(labels, [], {
      "https://a/1": "W1", "https://a/2": "W1", "https://a/3": "W1",
      "https://b/1": null, "https://b/2": null,
      "https://z/1": null,
    });
    expect(result.correct).toBe(4);
  });

  it("skips ambiguous tabs and tabs the run never saw", () => {
    const result = scoreClusters({ ...labels, "https://amb/1": "trip", "https://absent/1": "trip" }, ["https://amb/1"], {
      "https://a/1": "W1", "https://a/2": "W1", "https://a/3": "W1",
      "https://b/1": "W2", "https://b/2": "W2",
      "https://z/1": null,
      "https://amb/1": "W9", // would be wrong, but ambiguous tabs are not scored
    });
    expect(result).toMatchObject({ percent: 100, total: 6 });
  });

  it("scores 0 for an empty result rather than dividing by zero", () => {
    expect(scoreClusters(labels, [], {})).toMatchObject({ percent: 0, total: 0 });
  });
});
