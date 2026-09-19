import { defineManifest } from "@crxjs/vite-plugin";

// Background service worker only. No chrome_url_overrides (Home, feature 005)
// and no side_panel (Sidebar, feature 006) in this feature.
export default defineManifest({
  manifest_version: 3,
  name: "AI Browser",
  version: "0.0.0",
  background: {
    service_worker: "src/background.ts",
    type: "module",
  },
});
