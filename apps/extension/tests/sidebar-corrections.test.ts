import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config", () => ({
  loadConfig: vi.fn(() => ({
    ok: true,
    config: { apiBaseUrl: "http://localhost:3000", deviceToken: "token-ok-12" },
  })),
}));

import { moveTab } from "../src/corrections/api";

afterEach(() => vi.unstubAllGlobals());

describe("sidebar correction requests", () => {
  it("patches membership with workspaceId", async () => {
    const tabRef = {
      id: "t1",
      userId: "u1",
      workspaceId: "w2",
      url: "https://example.com",
      title: "ex",
      snippet: "",
      chromeTabId: 1,
      lastSeenAt: "",
      placementSource: "user",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tabRef }),
      }),
    );

    await expect(moveTab("t1", "w2")).resolves.toEqual({ ok: true, value: tabRef });
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/tab-refs/t1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ workspaceId: "w2" }),
      }),
    );
  });
});
