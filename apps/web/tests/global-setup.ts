import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const SCHEMAS = ["001_init.sql", "004_clustering.sql", "008_chat.sql", "010_agents.sql"].map((file) =>
  fileURLToPath(new URL(`../../../packages/shared/sql/${file}`, import.meta.url)),
);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/**
 * Starts a throwaway Postgres with the real 001, 004, 008, and 010 schemas and points the app at it.
 * DATABASE_URL is set explicitly, and src/db.ts never overrides a variable that is
 * already set, so these tests cannot reach a real database or read one from .env.
 * The same goes for the AI keys (VT and Gemini): they are blanked unless CLUSTER_LIVE=1, CHAT_LIVE=1, or AGENTS_LIVE=1,
 * so no test can call a real model (and use shared quota) by accident.
 */
export default async function setup() {
  const db = await PGlite.create();
  for (const schema of SCHEMAS) await db.exec(readFileSync(schema, "utf8"));
  const port = await freePort();
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 20 });
  await server.start();

  process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
  process.env.DEVICE_TOKEN_SECRET = "test-only-secret";
  if (process.env.CLUSTER_LIVE !== "1" && process.env.CHAT_LIVE !== "1" && process.env.AGENTS_LIVE !== "1") {
    for (const name of ["VT_LLM_API_KEY", "LLM_API_KEY", "GEMINI_API_KEY"]) process.env[name] = "";
  }

  return async () => {
    await server.stop();
    await db.close();
  };
}
