import { randomUUID } from "crypto";
import { requireUser } from "@/src/auth";
import { recordCorrection } from "@/src/corrections";
import { query } from "@/src/db";
import { errorJson, json, optionsResponse } from "@/src/json";
import { mapTabRef, TAB_REF_COLUMNS, type DbTabRef } from "@/src/map";

export const runtime = "nodejs";

export function OPTIONS() {
  return optionsResponse();
}

async function assertOwnWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  const result = await query(
    "SELECT 1 FROM workspaces WHERE id = $1 AND user_id = $2",
    [workspaceId, userId],
  );
  return result.rows.length > 0;
}

export async function GET(request: Request) {
  const { user, error } = await requireUser(request);
  if (error) return error;

  const params = new URL(request.url).searchParams;
  const workspaceId = params.get("workspaceId");
  const other = params.get("other") === "true";

  let sql = `SELECT ${TAB_REF_COLUMNS}
             FROM tab_refs WHERE user_id = $1`;
  const values: unknown[] = [user!.id];

  if (other) {
    sql += " AND workspace_id IS NULL";
  } else if (workspaceId) {
    values.push(workspaceId);
    sql += ` AND workspace_id = $${values.length}`;
  }
  sql += " ORDER BY last_seen_at DESC";

  const result = await query<DbTabRef>(sql, values);
  return json({ tabRefs: result.rows.map(mapTabRef) });
}

export async function PUT(request: Request) {
  const { user, error } = await requireUser(request);
  if (error) return error;

  let body: {
    id?: unknown;
    url?: unknown;
    title?: unknown;
    snippet?: unknown;
    chromeTabId?: unknown;
    workspaceId?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return errorJson("Invalid JSON", 400);
  }

  const url = typeof body.url === "string" ? body.url : "";
  if (!url) return errorJson("url is required", 400);

  const title = typeof body.title === "string" ? body.title : "";
  const snippet =
    typeof body.snippet === "string" ? body.snippet.slice(0, 2000) : "";
  const chromeTabId =
    typeof body.chromeTabId === "number" && Number.isInteger(body.chromeTabId)
      ? body.chromeTabId
      : null;

  let workspaceId: string | null | undefined;
  if (body.workspaceId === undefined) {
    workspaceId = undefined;
  } else if (body.workspaceId === null) {
    workspaceId = null;
  } else if (typeof body.workspaceId === "string") {
    workspaceId = body.workspaceId;
    if (!(await assertOwnWorkspace(user!.id, workspaceId))) {
      return errorJson("Workspace not found", 400);
    }
  } else {
    return errorJson("workspaceId must be a string or null", 400);
  }

  type Existing = { id: string; workspace_id: string | null; placement_source: "ai" | "user" | null };
  let existing = null as Existing | null;

  if (typeof body.id === "string") {
    const byId = await query<Existing>(
      "SELECT id, workspace_id, placement_source FROM tab_refs WHERE id = $1 AND user_id = $2",
      [body.id, user!.id],
    );
    existing = byId.rows[0] ?? null;
  }
  // A page is the same record across restarts; Chrome's tab id is not (it only
  // lasts one browser session), so it is never used to find a record.
  if (!existing) {
    const byUrl = await query<Existing>(
      `SELECT id, workspace_id, placement_source FROM tab_refs
       WHERE user_id = $1 AND url = $2
       ORDER BY (chrome_tab_id IS NOT DISTINCT FROM $3) DESC, last_seen_at DESC
       LIMIT 1`,
      [user!.id, url, chromeTabId],
    );
    existing = byUrl.rows[0] ?? null;
  }

  const targetId = existing ? existing.id : typeof body.id === "string" ? body.id : randomUUID();
  // A tab id belongs to one live tab: no other record of this user may keep it.
  if (chromeTabId !== null) {
    await query(
      "UPDATE tab_refs SET chrome_tab_id = NULL WHERE user_id = $1 AND chrome_tab_id = $2 AND id <> $3",
      [user!.id, chromeTabId, targetId],
    );
  }

  if (existing) {
    const nextWorkspace =
      workspaceId === undefined ? existing.workspace_id : workspaceId;
    // Sending workspaceId (even null = Other) is a decision by the user; leaving it
    // out keeps whoever placed the tab before (feature 004: placement_source).
    const result = await query<DbTabRef>(
      `UPDATE tab_refs
       SET url = $1, title = $2, snippet = $3, chrome_tab_id = $4, workspace_id = $5, last_seen_at = now(),
           placement_source = CASE WHEN $8::boolean THEN 'user' ELSE placement_source END
       WHERE id = $6 AND user_id = $7
       RETURNING ${TAB_REF_COLUMNS}`,
      [url, title, snippet, chromeTabId, nextWorkspace, existing.id, user!.id, workspaceId !== undefined],
    );
    // The user overrode where the AI put this tab: keep that as a signal (feature 004).
    if (workspaceId !== undefined && existing.placement_source === "ai" && nextWorkspace !== existing.workspace_id) {
      await recordCorrection(user!.id, existing.id, existing.workspace_id, nextWorkspace, url);
    }
    return json({ tabRef: mapTabRef(result.rows[0]) });
  }

  const id = targetId;
  const insertWorkspace = workspaceId === undefined ? null : workspaceId;
  const result = await query<DbTabRef>(
    `INSERT INTO tab_refs (id, user_id, workspace_id, url, title, snippet, chrome_tab_id, last_seen_at, placement_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), CASE WHEN $8::boolean THEN 'user' ELSE NULL END)
     RETURNING ${TAB_REF_COLUMNS}`,
    [id, user!.id, insertWorkspace, url, title, snippet, chromeTabId, workspaceId !== undefined],
  );
  return json({ tabRef: mapTabRef(result.rows[0]) });
}
