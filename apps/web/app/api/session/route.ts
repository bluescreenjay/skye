import { randomUUID } from "crypto";
import { hashDeviceToken } from "@/src/auth";
import { query } from "@/src/db";
import { errorJson, json, optionsResponse } from "@/src/json";

export const runtime = "nodejs";

const MIN_TOKEN_LENGTH = 8;

export function OPTIONS() {
  return optionsResponse();
}

export async function POST(request: Request) {
  let body: { deviceToken?: unknown };
  try {
    body = (await request.json()) as { deviceToken?: unknown };
  } catch {
    return errorJson("Invalid JSON", 400);
  }

  const deviceToken = typeof body.deviceToken === "string" ? body.deviceToken : "";
  if (deviceToken.length < MIN_TOKEN_LENGTH) {
    return errorJson("deviceToken must be at least 8 characters", 400);
  }

  let hash: string;
  try {
    hash = hashDeviceToken(deviceToken);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Hash failed";
    return errorJson(message, 500);
  }

  const existing = await query<{ id: string }>(
    "SELECT id FROM users WHERE device_token_hash = $1",
    [hash],
  );
  if (existing.rows[0]) {
    return json({ userId: existing.rows[0].id });
  }

  const id = randomUUID();
  await query("INSERT INTO users (id, device_token_hash) VALUES ($1, $2)", [id, hash]);
  return json({ userId: id });
}
