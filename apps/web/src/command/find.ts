// "Find my flight tab" / "which workspace has the ramen recipes" (specs/011-global-command-bar/research.md 11;
// spec FR-035). The model ranks short ids from the material it was shown (saved titles, addresses without
// query strings, and short excerpts); this file turns the ones the server recognized into rows read from the
// database. It fetches no page, changes nothing, and never returns a tab of an archived workspace even if one
// was archived while the model was thinking. Nothing here logs.
import type { FoundTab, FoundWorkspace } from "@ai-browser/shared";
import { mapTabRef, mapWorkspace, TAB_REF_COLUMNS, type DbTabRef, type DbWorkspace } from "../map";
import type { Db } from "./context";
import { MAX_FOUND_TABS, MAX_FOUND_WORKSPACES } from "./limits";

export interface Found {
  tabs: FoundTab[];
  workspaces: FoundWorkspace[];
  /** Tabs the model ranked beyond the ones shown. */
  more: number;
}

export async function buildFound(db: Db, userId: string, tabIds: string[], workspaceIds: string[]): Promise<Found> {
  // Tabs, in the model's order. A tab in an archived workspace is dropped.
  const tabRows = tabIds.length
    ? (await db.query<DbTabRef>(`SELECT ${TAB_REF_COLUMNS} FROM tab_refs WHERE user_id = $1::uuid AND id = ANY($2::uuid[])`, [userId, tabIds])).rows
    : [];
  const owners = [...new Set(tabRows.map((r) => r.workspace_id).filter((id): id is string => id !== null))];
  const names = new Map<string, { name: string; status: string }>();
  if (owners.length > 0) {
    const rows = await db.query<{ id: string; name: string; status: string }>(`SELECT id, name, status FROM workspaces WHERE user_id = $1::uuid AND id = ANY($2::uuid[])`, [userId, owners]);
    for (const r of rows.rows) names.set(r.id, { name: r.name, status: r.status });
  }
  const byId = new Map(tabRows.map((r) => [r.id, r]));
  const ranked: FoundTab[] = [];
  for (const id of tabIds) {
    const row = byId.get(id);
    if (!row) continue;
    const owner = row.workspace_id === null ? null : names.get(row.workspace_id);
    if (row.workspace_id !== null && (!owner || owner.status === "archived")) continue;
    ranked.push({ tab: mapTabRef(row), workspaceName: owner ? owner.name : "Other" });
  }

  // Workspaces, in the model's order, active only, each with how many tabs it holds.
  let workspaces: FoundWorkspace[] = [];
  if (workspaceIds.length > 0) {
    const rows = await db.query<DbWorkspace>(
      `SELECT id, user_id, name, emoji, status, created_at, updated_at FROM workspaces WHERE user_id = $1::uuid AND id = ANY($2::uuid[]) AND status <> 'archived'`,
      [userId, workspaceIds],
    );
    const counts = await db.query<{ workspace_id: string; n: string }>(
      `SELECT workspace_id, count(*) AS n FROM tab_refs WHERE user_id = $1::uuid AND workspace_id = ANY($2::uuid[]) GROUP BY workspace_id`,
      [userId, workspaceIds],
    );
    const tabCount = new Map(counts.rows.map((r) => [r.workspace_id, Number(r.n)]));
    const found = new Map(rows.rows.map((r) => [r.id, r]));
    workspaces = workspaceIds
      .map((id) => found.get(id))
      .filter((r): r is DbWorkspace => r !== undefined)
      .slice(0, MAX_FOUND_WORKSPACES)
      .map((r) => ({ workspace: mapWorkspace(r), tabCount: tabCount.get(r.id) ?? 0 }));
  }

  return { tabs: ranked.slice(0, MAX_FOUND_TABS), workspaces, more: Math.max(0, ranked.length - MAX_FOUND_TABS) };
}
