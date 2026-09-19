import { requireUser } from "@/src/auth";
import { query } from "@/src/db";
import { errorJson, json, optionsResponse } from "@/src/json";
import { mapWorkspace, type DbWorkspace } from "@/src/map";

export const runtime = "nodejs";

export function OPTIONS() {
  return optionsResponse();
}

async function loadOwnWorkspace(userId: string, id: string) {
  const result = await query<DbWorkspace>(
    `SELECT id, user_id, name, emoji, status, created_at, updated_at
     FROM workspaces WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return result.rows[0] ?? null;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  const { id } = await context.params;
  const row = await loadOwnWorkspace(user!.id, id);
  if (!row) return errorJson("Workspace not found", 404);
  return json({ workspace: mapWorkspace(row) });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  const { id } = await context.params;
  const existing = await loadOwnWorkspace(user!.id, id);
  if (!existing) return errorJson("Workspace not found", 404);

  let body: { name?: unknown; emoji?: unknown; status?: unknown };
  try {
    body = (await request.json()) as { name?: unknown; emoji?: unknown; status?: unknown };
  } catch {
    return errorJson("Invalid JSON", 400);
  }

  let name = existing.name as string;
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length < 1 || body.name.trim().length > 80) {
      return errorJson("name must be 1–80 characters", 400);
    }
    name = body.name.trim();
  }

  let emoji = existing.emoji as string | null;
  if (body.emoji !== undefined) {
    emoji = body.emoji === null ? null : typeof body.emoji === "string" ? body.emoji : existing.emoji;
  }

  let status = existing.status as string;
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "archived") {
      return errorJson("status must be active or archived", 400);
    }
    status = body.status;
  }

  const result = await query<DbWorkspace>(
    `UPDATE workspaces
     SET name = $1, emoji = $2, status = $3, updated_at = now()
     WHERE id = $4 AND user_id = $5
     RETURNING id, user_id, name, emoji, status, created_at, updated_at`,
    [name, emoji, status, id, user!.id],
  );
  return json({ workspace: mapWorkspace(result.rows[0]) });
}
