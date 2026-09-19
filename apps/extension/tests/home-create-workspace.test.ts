import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config", () => ({
  loadConfig: vi.fn(),
}));

import { loadConfig } from "../src/config";
import { createWorkspace } from "../src/corrections/api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(loadConfig).mockReset();
});

describe("createWorkspace", () => {
  it("rejects an empty name without calling the API", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    await expect(createWorkspace("   ")).resolves.toEqual({ ok: false, reason: "bad_name" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts a workspace when paired", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      ok: true,
      config: { apiBaseUrl: "http://localhost:3000", deviceToken: "token-ok-12" },
    });
    const workspace = {
      id: "w1",
      userId: "u1",
      name: "hackathon",
      emoji: null,
      status: "active",
      createdAt: "",
      updatedAt: "",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ workspace }),
      }),
    );

    await expect(createWorkspace("Hackathon")).resolves.toEqual({ ok: true, value: workspace });
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/workspaces",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reports unpaired when config is missing", async () => {
    vi.mocked(loadConfig).mockReturnValue({ ok: false, reason: "missing" });
    await expect(createWorkspace("trip")).resolves.toEqual({ ok: false, reason: "unpaired" });
  });
});
