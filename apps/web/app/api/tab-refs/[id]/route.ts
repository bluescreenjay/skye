import { requireUser } from "@/src/auth";
import { recordCorrection } from "@/src/corrections";
import { query } from "@/src/db";
import { errorJson, json, optionsResponse } from "@/src/json";
import { mapTabRef, TAB_REF_COLUMNS, type DbTabRef } from "@/src/map";

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

  const existing = await query<{ id: string; url: string; workspace_id: string | null; placement_source: "ai" | "user" | null }>(
    `SELECT id, url, workspace_id, placement_source FROM tab_refs WHERE id = $1 AND user_id = $2`,
    [id, user!.id],
  );
  const before = existing.rows[0];
  if (!before) return errorJson("Tab not found", 404);

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
      sets.push("placement_source = 'user'"); // the user decided (Other is a decision too)
    } else if (typeof body.workspaceId === "string") {
      const ws = await query(
        "SELECT 1 FROM workspaces WHERE id = $1 AND user_id = $2",
        [body.workspaceId, user!.id],
      );
      if (!ws.rows[0]) return errorJson("Workspace not found", 400);
      values.push(body.workspaceId);
      sets.push(`workspace_id = $${values.length}`);
      sets.push("placement_source = 'user'");
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
      `SELECT ${TAB_REF_COLUMNS}
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
     RETURNING ${TAB_REF_COLUMNS}`,
    values,
  );
  // The user overrode where the AI put this tab: keep that as a signal (feature 004).
  if (body.workspaceId !== undefined && before.placement_source === "ai" && (body.workspaceId ?? null) !== before.workspace_id) {
    await recordCorrection(user!.id, before.id, before.workspace_id, (body.workspaceId as string | null) ?? null, before.url);
  }
  return json({ tabRef: mapTabRef(result.rows[0]) });
}
