// Suggestions: stored proposals that never move a tab until the user accepts
// (data-model.md, "suggestions"). List, accept, ignore, and withdraw the stale ones.
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { randomUUID } from "crypto";
import type { Suggestion, SuggestionView, TabRef, Workspace } from "@ai-browser/shared";
import { query, withTransaction } from "../db";
import {
  mapSuggestion,
  mapTabRef,
  mapWorkspace,
  SUGGESTION_COLUMNS,
  TAB_REF_COLUMNS,
  type DbSuggestion,
  type DbTabRef,
  type DbWorkspace,
} from "../map";
import { recordReassignments } from "./apply";
import { MIN_GROUP_SIZE } from "./model";
import { findExistingWorkspace } from "./target";

const WORKSPACE_COLUMNS = "id, user_id, name, emoji, status, created_at, updated_at";

/** Either the pool helper or a transaction's client. */
export type Db = { query: <T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) => Promise<QueryResult<T>> };

export class SuggestionNotFound extends Error {
  constructor() {
    super("Suggestion not found.");
    this.name = "SuggestionNotFound";
  }
}
export class SuggestionNotPending extends Error {
  constructor() {
    super("That suggestion has already been accepted, ignored, or withdrawn.");
    this.name = "SuggestionNotPending";
  }
}
export class SuggestionStale extends Error {
  constructor() {
    super("Too few of that suggestion's tabs are still unplaced.");
    this.name = "SuggestionStale";
  }
}

/**
 * Pending suggestions with fewer than two tabs still in Other and unplaced can no
 * longer be offered: withdraw them. Returns how many were withdrawn.
 */
export async function withdrawStale(db: Db, userId: string): Promise<number> {
  const result = await db.query(
    `UPDATE suggestions s SET status = 'withdrawn', resolved_at = now()
     WHERE s.user_id = $1 AND s.status = 'pending'
       AND (SELECT count(*) FROM tab_refs t
            WHERE t.user_id = s.user_id AND t.id = ANY(s.tab_ref_ids)
              AND t.workspace_id IS NULL AND t.placement_source IS NULL) < $2`,
    [userId, MIN_GROUP_SIZE],
  );
  return result.rowCount ?? 0;
}

/**
 * Suggestions as a client shows them: only the member tabs that are still unplaced,
 * and the existing workspace a suggestion would join. Everything is read with the
 * user's id, so a foreign or missing tab id in the array can never surface.
 */
export async function toSuggestionViews(db: Db, userId: string, rows: DbSuggestion[]): Promise<SuggestionView[]> {
  if (rows.length === 0) return [];
  const tabIds = [...new Set(rows.flatMap((r) => r.tab_ref_ids))];
  const workspaceIds = [...new Set(rows.map((r) => r.target_workspace_id).filter((id): id is string => id !== null))];

  const tabs = await db.query<DbTabRef>(
    `SELECT ${TAB_REF_COLUMNS} FROM tab_refs
     WHERE user_id = $1 AND id = ANY($2::uuid[]) AND workspace_id IS NULL AND placement_source IS NULL`,
    [userId, tabIds],
  );
  const eligible = new Map<string, TabRef>(tabs.rows.map((t) => [t.id, mapTabRef(t)]));

  const spaces = new Map<string, Workspace>();
  if (workspaceIds.length > 0) {
    const found = await db.query<DbWorkspace>(
      `SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE user_id = $1 AND id = ANY($2::uuid[])`,
      [userId, workspaceIds],
    );
    for (const w of found.rows) spaces.set(w.id, mapWorkspace(w));
  }

  return rows.map((row) => ({
    ...mapSuggestion(row),
    tabRefs: row.tab_ref_ids.map((id) => eligible.get(id)).filter((t): t is TabRef => t !== undefined),
    targetWorkspace: row.target_workspace_id ? (spaces.get(row.target_workspace_id) ?? null) : null,
  }));
}

/** The views for specific suggestions (a run's results). */
export async function getSuggestionViews(db: Db, userId: string, ids: string[]): Promise<SuggestionView[]> {
  if (ids.length === 0) return [];
  const rows = await db.query<DbSuggestion>(
    `SELECT ${SUGGESTION_COLUMNS} FROM suggestions WHERE user_id = $1 AND id = ANY($2::uuid[]) ORDER BY created_at DESC, id`,
    [userId, ids],
  );
  return toSuggestionViews(db, userId, rows.rows);
}

export type SuggestionFilter = "pending" | "accepted" | "ignored" | "all";

/** This user's suggestions, newest first. Pending ones that have gone stale are withdrawn first. */
export async function listSuggestions(userId: string, status: SuggestionFilter = "pending"): Promise<SuggestionView[]> {
  if (status === "pending" || status === "all") await withdrawStale({ query }, userId);
  const rows =
    status === "all"
      ? await query<DbSuggestion>(
          `SELECT ${SUGGESTION_COLUMNS} FROM suggestions WHERE user_id = $1 ORDER BY created_at DESC, id`,
          [userId],
        )
      : await query<DbSuggestion>(
          `SELECT ${SUGGESTION_COLUMNS} FROM suggestions WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC, id`,
          [userId, status],
        );
  return toSuggestionViews({ query }, userId, rows.rows);
}

/** Dismiss a suggestion. Ignoring one that is already ignored is a no-op. */
export async function ignoreSuggestion(userId: string, id: string): Promise<Suggestion> {
  const updated = await query<DbSuggestion>(
    `UPDATE suggestions SET status = 'ignored', resolved_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'pending'
     RETURNING ${SUGGESTION_COLUMNS}`,
    [id, userId],
  );
  if (updated.rows[0]) return mapSuggestion(updated.rows[0]);

  const existing = await query<DbSuggestion>(
    `SELECT ${SUGGESTION_COLUMNS} FROM suggestions WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  if (!existing.rows[0]) throw new SuggestionNotFound();
  if (existing.rows[0].status === "ignored") return mapSuggestion(existing.rows[0]);
  throw new SuggestionNotPending();
}

export interface AcceptResult {
  suggestion: Suggestion;
  workspace: Workspace;
  created: boolean;
  tabRefs: TabRef[];
}

/**
 * Accept: put the suggestion's still-unplaced tabs in the workspace as the USER's own
 * placement. If fewer than two of its tabs are still unplaced it is withdrawn instead.
 */
export async function acceptSuggestion(userId: string, id: string): Promise<AcceptResult> {
  const outcome = await withTransaction<AcceptResult | "stale">(async (client) => {
    const found = await client.query<DbSuggestion>(
      `SELECT ${SUGGESTION_COLUMNS} FROM suggestions WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [id, userId],
    );
    const row = found.rows[0];
    if (!row) throw new SuggestionNotFound();
    if (row.status !== "pending") throw new SuggestionNotPending();

    // Lock the member tabs that are still up for grabs.
    const free = await client.query<{ id: string }>(
      `SELECT id FROM tab_refs
       WHERE user_id = $1 AND id = ANY($2::uuid[]) AND workspace_id IS NULL AND placement_source IS NULL
       FOR UPDATE`,
      [userId, row.tab_ref_ids],
    );
    const tabIds = free.rows.map((t) => t.id);
    if (tabIds.length < MIN_GROUP_SIZE) {
      await client.query(`UPDATE suggestions SET status = 'withdrawn', resolved_at = now() WHERE id = $1 AND user_id = $2`, [id, userId]);
      return "stale"; // returned, not thrown, so the withdrawal is committed
    }

    const { workspace, created } = await targetWorkspace(client, userId, row);

    const moved = await client.query<DbTabRef>(
      `UPDATE tab_refs SET workspace_id = $1, placement_source = 'user'
       WHERE user_id = $2 AND id = ANY($3::uuid[])
       RETURNING ${TAB_REF_COLUMNS}`,
      [workspace.id, userId, tabIds],
    );
    await recordReassignments(client, userId, tabIds, workspace.id);

    const accepted = await client.query<DbSuggestion>(
      `UPDATE suggestions SET status = 'accepted', resolved_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING ${SUGGESTION_COLUMNS}`,
      [id, userId],
    );
    return { suggestion: mapSuggestion(accepted.rows[0]), workspace: mapWorkspace(workspace), created, tabRefs: moved.rows.map(mapTabRef) };
  });

  if (outcome === "stale") throw new SuggestionStale();
  return outcome;
}

/**
 * The workspace an accepted suggestion goes to: the one it targets if that is still
 * active, else an active one with the same name, else a new one. Same rule as a run.
 */
async function targetWorkspace(client: PoolClient, userId: string, row: DbSuggestion): Promise<{ workspace: DbWorkspace; created: boolean }> {
  const existing = await findExistingWorkspace(client, userId, { name: row.name, existingWorkspaceId: row.target_workspace_id });
  if (existing) return { workspace: existing, created: false };
  const created = await client.query<DbWorkspace>(
    `INSERT INTO workspaces (id, user_id, name, emoji, status) VALUES ($1, $2, $3, $4, 'active') RETURNING ${WORKSPACE_COLUMNS}`,
    [randomUUID(), userId, row.name, row.emoji],
  );
  return { workspace: created.rows[0], created: true };
}
