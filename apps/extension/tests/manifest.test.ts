import { describe, expect, it } from "vitest";
import manifest from "../manifest.config";

// The manifest is the extension's contract with the browser: what it may read
// and which surfaces it adds. See specs/002-tab-ingestion-extension/contracts/extension-config.md.
const m = manifest as unknown as Record<string, unknown>;

describe("manifest", () => {
  it("is a Manifest V3 extension with a background service worker only", () => {
    expect(m.manifest_version).toBe(3);
    expect(m.background).toEqual({ service_worker: "src/background.ts", type: "module" });
  });

  it("asks for exactly the permissions the design needs", () => {
    expect([...(m.permissions as string[])].sort()).toEqual(["alarms", "scripting", "storage"]);
    expect([...(m.host_permissions as string[])].sort()).toEqual(["http://*/*", "https://*/*"]);
  });

  it("is never enabled in incognito windows", () => {
    expect(m.incognito).toBe("not_allowed");
  });

  it("has a bare toolbar action, with no popup, only so the status badge can show", () => {
    expect(m.action).toEqual({ default_title: "AI Browser sync" });
  });

  it.each([
    "chrome_url_overrides", // Home is feature 005
    "side_panel", // Sidebar is feature 006
    "content_scripts",
    "web_accessible_resources",
    "options_page",
    "options_ui",
    "devtools_page",
    "omnibox",
    "commands",
    "sandbox",
  ])("does not declare %s", (key) => {
    expect(m).not.toHaveProperty(key);
  });

  it.each(["tabs", "activeTab", "<all_urls>", "unlimitedStorage", "sidePanel", "tabGroups", "history", "bookmarks", "cookies", "webNavigation", "webRequest"])(
    "does not ask for the %s permission",
    (permission) => {
      const asked = [...((m.permissions as string[]) ?? []), ...((m.host_permissions as string[]) ?? [])];
      expect(asked).not.toContain(permission);
    },
  );

  it("does not add an optional permission path either", () => {
    expect(m).not.toHaveProperty("optional_permissions");
    expect(m).not.toHaveProperty("optional_host_permissions");
  });
});
