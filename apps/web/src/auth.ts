import { createHash } from "crypto";
import type { User } from "@ai-browser/shared";
import { query } from "./db";
import { errorJson } from "./json";
import { mapUser, type DbUser } from "./map";

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
