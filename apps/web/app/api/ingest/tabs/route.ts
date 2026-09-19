import { bearerToken, ensureUser } from "@/src/auth";
import { withTransaction } from "@/src/db";
import { applyBatch, MAX_BODY_BYTES, parseBatch } from "@/src/ingest";
import { errorJson, json, optionsResponse } from "@/src/json";

export const runtime = "nodejs";

export function OPTIONS() {
  return optionsResponse();
}

// The endpoint the Chrome extension posts to. Contract:
// specs/002-tab-ingestion-extension/contracts/ingest-api.md
export async function POST(request: Request) {
  const token = bearerToken(request);
  if (!token) return errorJson("Missing Authorization Bearer token", 401);

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return errorJson("Request body too large", 413);
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return errorJson("Request body too large", 413);

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return errorJson("Invalid JSON", 400);
  }
  const parsed = parseBatch(raw);
  if (!parsed.ok) return errorJson(parsed.error, parsed.status);

  try {
    // A token the server has not seen before creates its user (the extension has no separate pairing step).
    const user = await ensureUser(token);
    if (!user) return errorJson("Invalid device token: it must be at least 8 characters", 401);

    const result = await withTransaction((client) => applyBatch(client, user.id, parsed.batch));
    return json(result);
  } catch (err) {
    // The extension retries a 500, and applying a batch again is safe. The
    // detail stays in the server log, not in the response.
    console.error("[ingest] failed", err);
    return errorJson("Ingest failed", 500);
  }
}
