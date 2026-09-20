// Database reads for the command bar. Every query filters by `user_id`. Nothing here writes, and
// nothing here logs. (specs/011-global-command-bar/data-model.md, "CommandContext" and "Resolving").
import type { QueryResult, QueryResultRow } from "pg";
import type { CommandContext, PlacementSource } from "@ai-browser/shared";
import { MAX_MOVES_PER_CHANGE, MAX_TABS_IN_PROMPT, MAX_WORKSPACES_IN_PROMPT } from "./limits";
import type { MaterialTab, MaterialWorkspace } from "./prompt";

/** Either the pool helper or a transaction's client. */
export type Db = { query: <T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) => Promise<QueryResult<T>> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

export interface WorkspaceRow {
  id: string;
  name: string;
}

/** What the model is shown: active workspaces, and web tabs in Other or in an active workspace. */
export async function readMaterial(db: Db, userId: string): Promise<{ workspaces: MaterialWorkspace[]; tabs: MaterialTab[]; total: number }> {
  const workspaces = await db.query<WorkspaceRow>(
    `SELECT id, name FROM workspaces WHERE user_id = $1 AND status <> 'archived' ORDER BY created_at, id LIMIT $2`,
    [userId, MAX_WORKSPACES_IN_PROMPT],
  );
  const tabs = await db.query<{ id: string; url: string; title: string; snippet: string; workspace_id: string | null; total: string }>(
    `SELECT t.id, t.url, t.title, t.snippet, t.workspace_id, count(*) OVER () AS total
     FROM tab_refs t
     LEFT JOIN workspaces w ON w.id = t.workspace_id AND w.user_id = t.user_id
     WHERE t.user_id = $1 AND t.url ~* '^https?://' AND (t.workspace_id IS NULL OR w.status <> 'archived')
     ORDER BY (t.chrome_tab_id IS NOT NULL) DESC, t.last_seen_at DESC, t.id
     LIMIT $2`,
    [userId, MAX_TABS_IN_PROMPT],
  );
  return {
    workspaces: workspaces.rows,
    tabs: tabs.rows.map((r) => ({ id: r.id, url: r.url, title: r.title, snippet: r.snippet, workspaceId: r.workspace_id })),
    total: tabs.rows.length > 0 ? Number(tabs.rows[0].total) : 0,
  };
}

export async function activeWorkspaceNames(db: Db, userId: string): Promise<string[]> {
  const result = await db.query<{ name: string }>(
    `SELECT name FROM workspaces WHERE user_id = $1 AND status <> 'archived' ORDER BY created_at, id LIMIT 12`,
    [userId],
  );
  return result.rows.map((r) => r.name);
}

/** The person's own workspace (any status), or null. A malformed id is null without asking the database. */
export async function findWorkspaceRow(db: Db, userId: string, id: string): Promise<(WorkspaceRow & { status: string }) | null> {
  if (!isUuid(id)) return null;
  const result = await db.query<WorkspaceRow & { status: string }>(
    `SELECT id, name, status FROM workspaces WHERE id = $1::uuid AND user_id = $2::uuid`,
    [id, userId],
  );
  return result.rows[0] ?? null;
}

/** The names of some of the person's workspaces by id (for messages). */
export async function workspaceNames(db: Db, userId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const result = await db.query<WorkspaceRow>(`SELECT id, name FROM workspaces WHERE user_id = $1::uuid AND id = ANY($2::uuid[])`, [userId, ids]);
  return new Map(result.rows.map((r) => [r.id, r.name]));
}

export interface TabRow {
  id: string;
  url: string;
  title: string;
  workspaceId: string | null;
  placementSource: PlacementSource | null;
  chromeTabId: number | null;
}

type DbTab = { id: string; url: string; title: string; workspace_id: string | null; placement_source: PlacementSource | null; chrome_tab_id: number | null };
const mapTab = (r: DbTab): TabRow => ({
  id: r.id,
  url: r.url,
  title: r.title,
  workspaceId: r.workspace_id,
  placementSource: r.placement_source,
  chromeTabId: r.chrome_tab_id,
});
const TAB_COLS = "id, url, title, workspace_id, placement_source, chrome_tab_id";

/** Tabs by id, only the person's own, in the order asked. */
export async function readTabs(db: Db, userId: string, ids: string[]): Promise<TabRow[]> {
  if (ids.length === 0) return [];
  const result = await db.query<DbTab>(`SELECT ${TAB_COLS} FROM tab_refs WHERE user_id = $1::uuid AND id = ANY($2::uuid[])`, [userId, ids]);
  const byId = new Map(result.rows.map((r) => [r.id, mapTab(r)]));
  return ids.map((id) => byId.get(id)).filter((t): t is TabRow => t !== undefined);
}

/**
 * The record of the page in the active tab: the one bound to this Chrome tab id when its address still
 * matches (ingestion can lag a navigation), else the most recently seen record of the same address.
 */
export async function activeTabRow(db: Db, userId: string, context: CommandContext): Promise<TabRow | null> {
  const active = context.activeTab;
  if (!active) return null;
  const byChrome = await db.query<DbTab>(`SELECT ${TAB_COLS} FROM tab_refs WHERE user_id = $1 AND chrome_tab_id = $2 LIMIT 1`, [userId, active.chromeTabId]);
  if (byChrome.rows[0] && byChrome.rows[0].url === active.url) return mapTab(byChrome.rows[0]);
  const byUrl = await db.query<DbTab>(`SELECT ${TAB_COLS} FROM tab_refs WHERE user_id = $1 AND url = $2 ORDER BY last_seen_at DESC LIMIT 1`, [userId, active.url]);
  return byUrl.rows[0] ? mapTab(byUrl.rows[0]) : null;
}

export type Current =
  | { kind: "workspace"; workspace: WorkspaceRow }
  | { kind: "none" }
  | { kind: "several" }
  | { kind: "other" };

/**
 * "This workspace" (spec FR-008): on a page, the workspace of the active tab (`other` when that tab is in
 * none); on Home, the single expanded card (`none` for zero, `several` for more than one).
 */
export async function resolveCurrent(db: Db, userId: string, context: CommandContext): Promise<Current> {
  if (context.surface === "page") {
    const tab = await activeTabRow(db, userId, context);
    if (!tab) return context.activeTab ? { kind: "other" } : { kind: "none" };
    if (tab.workspaceId === null) return { kind: "other" };
    const ws = await findWorkspaceRow(db, userId, tab.workspaceId);
    return ws && ws.status !== "archived" ? { kind: "workspace", workspace: { id: ws.id, name: ws.name } } : { kind: "other" };
  }
  const ids = context.expandedWorkspaceIds.filter(isUuid);
  const found: WorkspaceRow[] = [];
  for (const id of ids) {
    const ws = await findWorkspaceRow(db, userId, id);
    if (ws && ws.status !== "archived") found.push({ id: ws.id, name: ws.name });
  }
  if (found.length === 0) return { kind: "none" };
  if (found.length > 1) return { kind: "several" };
  return { kind: "workspace", workspace: found[0] };
}

/**
 * "These tabs". For `create`: on Home the live tabs in Other; on a page this window's tabs that are in no
 * workspace. For `move`: the tabs of the current workspace. Web addresses only. At most one more than a
 * change may touch, so the caller can tell "too many".
 */
export async function theseTabs(db: Db, userId: string, context: CommandContext, purpose: "create" | "move", current: Current): Promise<TabRow[]> {
  const limit = MAX_MOVES_PER_CHANGE + 1;
  if (purpose === "move") {
    if (current.kind !== "workspace") return [];
    const result = await db.query<DbTab>(
      `SELECT ${TAB_COLS} FROM tab_refs WHERE user_id = $1 AND workspace_id = $2 AND url ~* '^https?://'
       ORDER BY (chrome_tab_id IS NOT NULL) DESC, last_seen_at DESC, id LIMIT $3`,
      [userId, current.workspace.id, limit],
    );
    return result.rows.map(mapTab);
  }
  if (context.surface === "home") {
    const result = await db.query<DbTab>(
      `SELECT ${TAB_COLS} FROM tab_refs
       WHERE user_id = $1 AND workspace_id IS NULL AND chrome_tab_id IS NOT NULL AND url ~* '^https?://'
       ORDER BY last_seen_at DESC, id LIMIT $2`,
      [userId, limit],
    );
    return result.rows.map(mapTab);
  }
  if (context.windowTabIds.length === 0) return [];
  const result = await db.query<DbTab>(
    `SELECT ${TAB_COLS} FROM tab_refs
     WHERE user_id = $1 AND workspace_id IS NULL AND chrome_tab_id = ANY($2::int[]) AND url ~* '^https?://'
     ORDER BY last_seen_at DESC, id LIMIT $3`,
    [userId, context.windowTabIds, limit],
  );
  return result.rows.map(mapTab);
}
