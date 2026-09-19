import { crx } from "@crxjs/vite-plugin";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import manifest from "./manifest.config";

const root = path.dirname(fileURLToPath(import.meta.url));

// VITE_* values in apps/extension/.env reach src/ through import.meta.env at
// build time (see config.ts). The device token ends up inside dist/, so dist/
// must never be committed or shared. Home and the Side Panel are separate pages.
//
// Chrome extension pages reject Vite's <link rel="modulepreload"> for shared
// chunks ("cross-world extension resource mismatch"). Disable preloads; ES
// imports from both entries still load config normally.
export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    modulePreload: false,
    rollupOptions: {
      input: {
        home: path.resolve(root, "home.html"),
        sidepanel: path.resolve(root, "sidepanel.html"),
      },
    },
  },
});
