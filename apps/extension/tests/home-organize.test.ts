import { describe, expect, it } from "vitest";
import { mapClusterHttpResult } from "../src/home/organize";

describe("mapClusterHttpResult", () => {
  it("maps applied success to idle with refresh", () => {
    const outcome = mapClusterHttpResult(200, {
      skipped: false,
      applied: [{ workspace: { name: "hackathon" }, created: true, tabRefIds: ["a"] }],
    });
    expect(outcome).toEqual({ status: "idle", message: "", shouldRefresh: true });
    expect(JSON.stringify(outcome)).not.toContain("refs — furniture");
  });

  it("maps skipped and empty applied to nothing to organize", () => {
    expect(mapClusterHttpResult(200, { skipped: true, applied: [] })).toEqual({
      status: "empty",
      message: "nothing to organize",
      shouldRefresh: true,
    });
    expect(mapClusterHttpResult(200, { skipped: false, applied: [] })).toEqual({
      status: "empty",
      message: "nothing to organize",
      shouldRefresh: true,
    });
  });

  it("maps 409 run_in_progress", () => {
    expect(mapClusterHttpResult(409, { error: "busy", code: "run_in_progress" })).toEqual({
      status: "failed",
      message: "already organizing",
      shouldRefresh: false,
    });
  });

  it("maps 401 and 503 without inventing dummy names", () => {
    const unauthorized = mapClusterHttpResult(401, { error: "Invalid pairing token" });
    expect(unauthorized.status).toBe("failed");
    expect(unauthorized.shouldRefresh).toBe(false);
    expect(unauthorized.message).toContain("pairing");

    const unconfigured = mapClusterHttpResult(503, { error: "no key", code: "model_unconfigured" });
    expect(unconfigured.status).toBe("failed");
    expect(unconfigured.message).toContain("not configured");

    const blob = JSON.stringify([unauthorized, unconfigured]);
    expect(blob).not.toContain("refs — furniture");
    expect(blob).not.toContain("ungrouped tabs");
  });

  it("maps network failure as status 0", () => {
    expect(mapClusterHttpResult(0, null)).toEqual({
      status: "failed",
      message: "could not reach the server",
      shouldRefresh: false,
    });
  });
});
