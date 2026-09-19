import { crx } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";
import manifest from "./manifest.config";

// VITE_* values in apps/extension/.env reach src/ through import.meta.env at
// build time (see config.ts). The device token ends up inside dist/, so dist/
// must never be committed or shared.
export default defineConfig({
  plugins: [crx({ manifest })],
});
