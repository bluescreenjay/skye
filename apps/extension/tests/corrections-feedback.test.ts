import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config", () => ({
  loadConfig: vi.fn(() => ({
    ok: true,
    config: { apiBaseUrl: "http://localhost:3000", deviceToken: "token-ok-12" },
  })),
}));

import { moveTab } from "../src/corrections/api";

afterEach(() => vi.unstubAllGlobals());

describe("correction feedback via PATCH", () => {
  it("sends workspaceId so the server can set placementSource user and record a correction", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tabRef: {
            id: "t1",
            userId: "u1",
            workspaceId: "w1",
            url: "https://example.com",
            title: "ex",
            snippet: "",
            chromeTabId: 1,
            lastSeenAt: "",
            placementSource: "user",
          },
        }),
      }),
    );

    const result = await moveTab("t1", "w1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.placementSource).toBe("user");
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/tab-refs/t1",
      expect.objectContaining({ body: JSON.stringify({ workspaceId: "w1" }) }),
    );
  });
});
