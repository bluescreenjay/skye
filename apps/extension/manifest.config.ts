import { defineManifest } from "@crxjs/vite-plugin";

// Background service worker only. See
// specs/002-tab-ingestion-extension/contracts/extension-config.md.
//
// Deliberately absent (this feature is observe-only):
//   chrome_url_overrides (Home, feature 005), side_panel (Sidebar, feature 006),
//   tabs, activeTab, <all_urls>, content_scripts, unlimitedStorage, any popup.
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
  permissions: ["storage", "alarms", "scripting"],
  // Lets the extension read url/title of web pages and their text, and reach
  // the API without CORS. Internal and extension pages never match.
  host_permissions: ["http://*/*", "https://*/*"],
  // Never enabled in incognito windows (the code also checks tab.incognito).
  incognito: "not_allowed",
  // A bare action, only so the sync-problem badge can be shown. No popup.
  action: { default_title: "AI Browser sync" },
});
