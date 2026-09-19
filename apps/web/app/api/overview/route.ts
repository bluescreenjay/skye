import type { TabRef } from "@ai-browser/shared";
import { requireUser } from "@/src/auth";
import { query } from "@/src/db";
import { json, optionsResponse } from "@/src/json";
import { mapTabRef, mapWorkspace, TAB_REF_COLUMNS, type DbTabRef, type DbWorkspace } from "@/src/map";
import { listSuggestions } from "@/src/cluster/suggestions";

export const runtime = "nodejs";

export function OPTIONS() {
  return optionsResponse();
}

/**
 * The Home read: every workspace with its tabs, the Other bucket, and pending
 * suggestions, in one call. Archived workspaces (and their tabs) are left out unless
 * `includeArchived=true`. Every TabRef carries `placementSource`.
 */
export async function GET(request: Request) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  const includeArchived = new URL(request.url).searchParams.get("includeArchived") === "true";

  const [workspaceRows, tabRows, suggestions] = await Promise.all([
    query<DbWorkspace>(
      `SELECT id, user_id, name, emoji, status, created_at, updated_at
       FROM workspaces WHERE user_id = $1 ${includeArchived ? "" : "AND status <> 'archived'"}
       ORDER BY created_at, id`,
      [user!.id],
    ),
    query<DbTabRef>(`SELECT ${TAB_REF_COLUMNS} FROM tab_refs WHERE user_id = $1 ORDER BY last_seen_at DESC, id`, [user!.id]),
    listSuggestions(user!.id, "pending"),
  ]);

  const byWorkspace = new Map<string, TabRef[]>();
  const other: TabRef[] = [];
  for (const row of tabRows.rows) {
    const tab = mapTabRef(row);
    if (tab.workspaceId === null) other.push(tab);
    else byWorkspace.set(tab.workspaceId, [...(byWorkspace.get(tab.workspaceId) ?? []), tab]);
  }

  return json({
    workspaces: workspaceRows.rows.map((w) => ({ workspace: mapWorkspace(w), tabRefs: byWorkspace.get(w.id) ?? [] })),
    other,
    suggestions,
  });
}
