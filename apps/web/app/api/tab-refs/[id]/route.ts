import { requireUser } from "@/src/auth";
import { query } from "@/src/db";
import { errorJson, json, optionsResponse } from "@/src/json";
import { mapTabRef, type DbTabRef } from "@/src/map";

export const runtime = "nodejs";

export function OPTIONS() {
  return optionsResponse();
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  const { id } = await context.params;

  const existing = await query(
    `SELECT id FROM tab_refs WHERE id = $1 AND user_id = $2`,
    [id, user!.id],
  );
  if (!existing.rows[0]) return errorJson("Tab not found", 404);

  let body: { workspaceId?: unknown; title?: unknown; snippet?: unknown };
  try {
    body = await request.json();
  } catch {
    return errorJson("Invalid JSON", 400);
  }

  const sets: string[] = [];
  const values: unknown[] = [];

  if (body.workspaceId !== undefined) {
    if (body.workspaceId === null) {
      values.push(null);
      sets.push(`workspace_id = $${values.length}`);
    } else if (typeof body.workspaceId === "string") {
      const ws = await query(
        "SELECT 1 FROM workspaces WHERE id = $1 AND user_id = $2",
        [body.workspaceId, user!.id],
      );
      if (!ws.rows[0]) return errorJson("Workspace not found", 400);
      values.push(body.workspaceId);
      sets.push(`workspace_id = $${values.length}`);
    } else {
      return errorJson("workspaceId must be a string or null", 400);
    }
  }

  if (typeof body.title === "string") {
    values.push(body.title);
    sets.push(`title = $${values.length}`);
  }
  if (typeof body.snippet === "string") {
    values.push(body.snippet.slice(0, 2000));
    sets.push(`snippet = $${values.length}`);
  }

  if (sets.length === 0) {
    const row = await query<DbTabRef>(
      `SELECT id, user_id, workspace_id, url, title, snippet, chrome_tab_id, last_seen_at
       FROM tab_refs WHERE id = $1 AND user_id = $2`,
      [id, user!.id],
    );
    return json({ tabRef: mapTabRef(row.rows[0]) });
  }

  sets.push("last_seen_at = now()");
  values.push(id, user!.id);
  const result = await query<DbTabRef>(
    `UPDATE tab_refs SET ${sets.join(", ")}
     WHERE id = $${values.length - 1} AND user_id = $${values.length}
     RETURNING id, user_id, workspace_id, url, title, snippet, chrome_tab_id, last_seen_at`,
    values,
  );
  return json({ tabRef: mapTabRef(result.rows[0]) });
}
