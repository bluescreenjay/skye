import { defineManifest } from "@crxjs/vite-plugin";

// Background service worker + Home page (feature 005). See
// specs/002-tab-ingestion-extension/contracts/extension-config.md and
// specs/005-home-all-workspaces/contracts/extension-home.md.
//
// Deliberately absent:
//   chrome_url_overrides (new-tab takeover deferred),
//   default_popup (Home is a full page), tabs, activeTab, <all_urls>,
//   content_scripts, unlimitedStorage.
// Feature 011 adds exactly one key, `commands`, for the command bar shortcut. It needs no
// permission; if Chrome cannot assign the key, the person sets one at chrome://extensions/shortcuts.
export default defineManifest({
  manifest_version: 3,
  name: "AI Browser",
  version: "0.0.0",
  background: {
    service_worker: "src/background.ts",
    type: "module",
  },
  // storage: durable backlog. alarms: 30-second heartbeat.
  // scripting: read a short text snippet from a page.
  // geolocation: Home greeting weather (page geolocation on chrome-extension://).
  permissions: ["storage", "alarms", "scripting", "geolocation", "sidePanel", "favicon"],
  side_panel: { default_path: "sidepanel.html" },
  // The command bar shortcut (feature 011). The handler is src/command-shortcut.ts.
  commands: {
    "open-command-bar": {
      suggested_key: { default: "Ctrl+K", mac: "Command+K" },
      description: "Open the command bar",
    },
  },
  // Lets the extension read url/title of web pages and their text, and reach
  // the API without CORS. Internal and extension pages never match.
  host_permissions: ["http://*/*", "https://*/*"],
  // Never enabled in incognito windows (the code also checks tab.incognito).
  incognito: "not_allowed",
  // Toolbar opens Home. No popup — onClicked in the service worker.
  action: { default_title: "skye home" },
});
