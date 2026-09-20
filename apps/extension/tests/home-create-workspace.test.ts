import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config", () => ({
  loadConfig: vi.fn(),
}));

import { loadConfig } from "../src/config";
import { archiveWorkspace, createWorkspace } from "../src/corrections/api";

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

describe("archiveWorkspace", () => {
  it("patches status archived when paired", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      ok: true,
      config: { apiBaseUrl: "http://localhost:3000", deviceToken: "token-ok-12" },
    });
    const workspace = {
      id: "w1",
      userId: "u1",
      name: "hackathon",
      emoji: null,
      status: "archived",
      createdAt: "",
      updatedAt: "",
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ workspace }),
    });
    vi.stubGlobal("fetch", fetchImpl);

    await expect(archiveWorkspace("w1")).resolves.toEqual({ ok: true, value: workspace });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:3000/api/workspaces/w1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "archived" }),
      }),
    );
  });

  it("reports failed when the server rejects", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      ok: true,
      config: { apiBaseUrl: "http://localhost:3000", deviceToken: "token-ok-12" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));
    await expect(archiveWorkspace("missing")).resolves.toEqual({ ok: false, reason: "failed" });
  });
});
