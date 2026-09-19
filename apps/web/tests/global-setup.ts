import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const SCHEMA = fileURLToPath(new URL("../../../packages/shared/sql/001_init.sql", import.meta.url));

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
 * Starts a throwaway Postgres with the real 001 schema and points the app at it.
 * DATABASE_URL is set explicitly, and src/db.ts never overrides a variable that is
 * already set, so these tests cannot reach a real database or read one from .env.
 */
export default async function setup() {
  const db = await PGlite.create();
  await db.exec(readFileSync(SCHEMA, "utf8"));
  const port = await freePort();
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 20 });
  await server.start();

  process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
  process.env.DEVICE_TOKEN_SECRET = "test-only-secret";

  return async () => {
    await server.stop();
    await db.close();
  };
}
