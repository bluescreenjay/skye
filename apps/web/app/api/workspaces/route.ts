import { randomUUID } from "crypto";
import { requireUser } from "@/src/auth";
import { query } from "@/src/db";
import { errorJson, json, optionsResponse } from "@/src/json";
import { mapWorkspace, type DbWorkspace } from "@/src/map";

export const runtime = "nodejs";

export function OPTIONS() {
  return optionsResponse();
}

export async function GET(request: Request) {
  const { user, error } = await requireUser(request);
  if (error) return error;

  const includeArchived =
    new URL(request.url).searchParams.get("includeArchived") === "true";

  const result = includeArchived
    ? await query<DbWorkspace>(
        `SELECT id, user_id, name, emoji, status, created_at, updated_at
         FROM workspaces WHERE user_id = $1 ORDER BY created_at ASC`,
        [user!.id],
      )
    : await query<DbWorkspace>(
        `SELECT id, user_id, name, emoji, status, created_at, updated_at
         FROM workspaces WHERE user_id = $1 AND status <> 'archived' ORDER BY created_at ASC`,
        [user!.id],
      );

  return json({ workspaces: result.rows.map(mapWorkspace) });
}

export async function POST(request: Request) {
  const { user, error } = await requireUser(request);
  if (error) return error;

  let body: { name?: unknown; emoji?: unknown };
  try {
    body = (await request.json()) as { name?: unknown; emoji?: unknown };
  } catch {
    return errorJson("Invalid JSON", 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 1 || name.length > 80) {
    return errorJson("name must be 1–80 characters", 400);
  }
  const emoji =
    body.emoji === undefined || body.emoji === null
      ? null
      : typeof body.emoji === "string"
        ? body.emoji
        : null;

  const id = randomUUID();
  const result = await query<DbWorkspace>(
    `INSERT INTO workspaces (id, user_id, name, emoji, status)
     VALUES ($1, $2, $3, $4, 'active')
     RETURNING id, user_id, name, emoji, status, created_at, updated_at`,
    [id, user!.id, name, emoji],
  );
  return json({ workspace: mapWorkspace(result.rows[0]) }, 201);
}
