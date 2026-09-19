import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { Pool, type QueryResult, type QueryResultRow } from "pg";

function loadRootEnv(): void {
  const envPath = resolve(process.cwd(), "../../.env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    value = value.trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadRootEnv();

let pool: Pool | null = null;

function normalizeDatabaseUrl(url: string): string {
  let normalized = url.trim();
  if (normalized.endsWith("?")) normalized = normalized.slice(0, -1);
  if (!/[?&]sslmode=/.test(normalized)) {
    normalized += `${normalized.includes("?") ? "&" : "?"}sslmode=require`;
  }
  return normalized;
}

export function getPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  if (!pool) {
    pool = new Pool({ connectionString: normalizeDatabaseUrl(url) });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}
