import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests call the route handlers directly against an in-process Postgres (PGlite),
// so they need no Next server and no real database.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,mts}"],
    globalSetup: ["./tests/global-setup.ts"],
    // One shared database, and PGlite runs a single session: files must not overlap.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
