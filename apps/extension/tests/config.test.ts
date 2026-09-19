import { describe, expect, it, vi } from "vitest";
import { createConfigLoader, loadConfig } from "../src/config";

const good = {
  VITE_API_BASE_URL: "http://localhost:8787",
  VITE_DEVICE_TOKEN: "dev-token",
};

describe("loadConfig", () => {
  it("accepts a valid base URL and token", () => {
    const result = loadConfig(good);
    expect(result).toEqual({
      ok: true,
      config: { apiBaseUrl: "http://localhost:8787", deviceToken: "dev-token" },
    });
  });

  it("removes trailing slashes from the base URL", () => {
    const result = loadConfig({ ...good, VITE_API_BASE_URL: "https://api.example.com//" });
    expect(result.ok && result.config.apiBaseUrl).toBe("https://api.example.com");
  });

  it("trims surrounding whitespace", () => {
    const result = loadConfig({ VITE_API_BASE_URL: "  http://localhost:8787 ", VITE_DEVICE_TOKEN: " t " });
    expect(result.ok && result.config).toEqual({ apiBaseUrl: "http://localhost:8787", deviceToken: "t" });
  });

  it.each([
    ["empty base URL", { ...good, VITE_API_BASE_URL: "" }],
    ["missing base URL", { VITE_DEVICE_TOKEN: "dev-token" }],
    ["empty token", { ...good, VITE_DEVICE_TOKEN: "" }],
    ["blank token", { ...good, VITE_DEVICE_TOKEN: "   " }],
    ["missing token", { VITE_API_BASE_URL: "http://localhost:8787" }],
  ])("reports misconfigured for %s", (_name, env) => {
    const result = loadConfig(env);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBeTruthy();
  });

  it.each(["ftp://example.com", "javascript:alert(1)", "localhost:8787", "not a url"])(
    "rejects a base URL that is not http(s): %s",
    (url) => {
      expect(loadConfig({ ...good, VITE_API_BASE_URL: url }).ok).toBe(false);
    },
  );

  it("never mentions the token value in a failure reason", () => {
    const result = loadConfig({ VITE_API_BASE_URL: "ftp://x", VITE_DEVICE_TOKEN: "super-secret-token" });
    expect(!result.ok && result.reason).not.toContain("super-secret-token");
  });
});

describe("createConfigLoader", () => {
  it("logs one warning, once, when config is missing", () => {
    const warn = vi.fn();
    const loader = createConfigLoader({}, warn);
    expect(loader.get().ok).toBe(false);
    expect(loader.get().ok).toBe(false);
    expect(loader.get().ok).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not warn for a valid config and returns the same result every time", () => {
    const warn = vi.fn();
    const loader = createConfigLoader(good, warn);
    const first = loader.get();
    expect(first.ok).toBe(true);
    expect(loader.get()).toBe(first);
    expect(warn).not.toHaveBeenCalled();
  });
});
