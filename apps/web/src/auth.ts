import { createHash, randomUUID } from "crypto";
import type { User } from "@ai-browser/shared";
import { query } from "./db";
import { errorJson } from "./json";
import { mapUser, type DbUser } from "./map";

/** Shortest device token accepted, for pairing and for the ingest endpoint. */
export const MIN_TOKEN_LENGTH = 8;

export function hashDeviceToken(token: string): string {
  const secret = process.env.DEVICE_TOKEN_SECRET;
  if (!secret) {
    throw new Error("DEVICE_TOKEN_SECRET is not set");
  }
  return createHash("sha256").update(`${secret}:${token}`).digest("hex");
}

export async function findUserByToken(token: string): Promise<User | null> {
  const hash = hashDeviceToken(token);
  const result = await query<DbUser>(
    "SELECT id, device_token_hash, created_at FROM users WHERE device_token_hash = $1",
    [hash],
  );
  const row = result.rows[0];
  return row ? mapUser(row) : null;
}

/**
 * The user for a device token, created the first time the token is seen. Returns
 * null for a token that is too short. Two first requests at once end up with the
 * same user: the second insert conflicts and reads the first one back.
 */
export async function ensureUser(token: string): Promise<User | null> {
  if (token.length < MIN_TOKEN_LENGTH) return null;
  const existing = await findUserByToken(token);
  if (existing) return existing;

  const created = await query<DbUser>(
    `INSERT INTO users (id, device_token_hash) VALUES ($1, $2)
     ON CONFLICT (device_token_hash) DO NOTHING
     RETURNING id, device_token_hash, created_at`,
    [randomUUID(), hashDeviceToken(token)],
  );
  if (created.rows[0]) return mapUser(created.rows[0]);
  return findUserByToken(token);
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

export async function requireUser(request: Request) {
  const token = bearerToken(request);
  if (!token) {
    return { user: null as User | null, error: errorJson("Missing Authorization Bearer token", 401) };
  }
  try {
    const user = await findUserByToken(token);
    if (!user) {
      return { user: null, error: errorJson("Invalid pairing token", 401) };
    }
    return { user, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Auth failed";
    return { user: null, error: errorJson(message, 500) };
  }
}
