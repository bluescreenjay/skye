import { defineConfig } from "vitest/config";

// A separate config so tests never load the CRXJS plugin from vite.config.ts.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
