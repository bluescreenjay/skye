import { describe, expect, it } from "vitest";
import manifest from "../manifest.config";

// The manifest is the extension's contract with the browser: what it may read
// and which surfaces it adds. See specs/006-chrome-sidebar-in-tab-workspace/contracts/sidebar.md.
const m = manifest as unknown as Record<string, unknown>;

describe("manifest", () => {
  it("is a Manifest V3 extension with a background service worker only", () => {
    expect(m.manifest_version).toBe(3);
    expect(m.background).toEqual({ service_worker: "src/background.ts", type: "module" });
  });

  it("asks for the permissions the design needs", () => {
    expect([...(m.permissions as string[])].sort()).toEqual([
      "alarms",
      "favicon",
      "geolocation",
      "scripting",
      "sidePanel",
      "storage",
    ]);
    expect([...(m.host_permissions as string[])].sort()).toEqual(["http://*/*", "https://*/*"]);
  });

  it("is never enabled in incognito windows", () => {
    expect(m.incognito).toBe("not_allowed");
  });

  it("has a toolbar action with no popup so the badge can show and Home can open", () => {
    expect(m.action).toEqual({ default_title: "skye home" });
    expect(m.action).not.toHaveProperty("default_popup");
  });

  it("provides a separate Side Panel page without taking the toolbar action", () => {
    expect(m.side_panel).toEqual({ default_path: "sidepanel.html" });
    expect(m.action).toEqual({ default_title: "skye home" });
  });

  it.each([
    "chrome_url_overrides", // Home is feature 005
    "content_scripts",
    "web_accessible_resources",
    "options_page",
    "options_ui",
    "devtools_page",
    "omnibox",
    "sandbox",
  ])("does not declare %s", (key) => {
    expect(m).not.toHaveProperty(key);
  });

  it.each(["tabs", "activeTab", "<all_urls>", "unlimitedStorage", "history", "bookmarks", "cookies", "webNavigation", "webRequest"])(
    "does not ask for the %s permission",
    (permission) => {
      const asked = [...((m.permissions as string[]) ?? []), ...((m.host_permissions as string[]) ?? [])];
      expect(asked).not.toContain(permission);
    },
  );

  it("declares exactly one command, the command bar shortcut, and needs no permission for it (feature 011)", () => {
    expect(m.commands).toEqual({
      "open-command-bar": {
        suggested_key: { default: "Ctrl+K", mac: "Command+K" },
        description: "Open the command bar",
      },
    });
  });

  it("does not add an optional permission path either", () => {
    expect(m).not.toHaveProperty("optional_permissions");
    expect(m).not.toHaveProperty("optional_host_permissions");
  });
});
