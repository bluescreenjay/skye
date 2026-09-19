#!/usr/bin/env node
// Runs one .sql file against DATABASE_URL (psql is not required).
//
//   node apps/web/scripts/apply-sql.mjs packages/shared/sql/004_clustering.sql
//
// DATABASE_URL comes from the environment or the repo-root .env, the same way
// apps/web/src/db.ts reads it (a variable that is already set is never overridden).
// This changes the database it points at, so it only prints the host, never the URL.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const file = process.argv[2];
if (!file) {
  console.error("usage: node apps/web/scripts/apply-sql.mjs <file.sql>");
  process.exit(2);
}

function loadRootEnv() {
  const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function normalizeDatabaseUrl(url) {
  let normalized = url.trim();
  if (normalized.endsWith("?")) normalized = normalized.slice(0, -1);
  if (!/[?&]sslmode=/.test(normalized)) {
    normalized += `${normalized.includes("?") ? "&" : "?"}sslmode=require`;
  }
  return normalized;
}

loadRootEnv();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (environment or repo-root .env).");
  process.exit(1);
}

const sqlPath = resolve(process.cwd(), file);
if (!existsSync(sqlPath)) {
  console.error(`No such file: ${file}`);
  process.exit(1);
}

const connectionString = normalizeDatabaseUrl(url);
const host = new URL(connectionString).host;
const client = new pg.Client({ connectionString });
try {
  await client.connect();
  await client.query(readFileSync(sqlPath, "utf8"));
  console.log(`applied ${file} to ${host}`);
} catch (error) {
  // The message names the SQL problem; it never contains the connection string.
  console.error(`failed on ${host}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
