// Applies validated groups inside the caller's transaction (data-model.md, "Apply").
// One SAVEPOINT per group, so a group that ends up too small leaves nothing behind
// (no orphan workspace). Every statement is set-based: a round trip per tab would be
// far too slow against a remote database.
//
// Order of decisions for each group, most confident first:
//   1. Overlap with the user's stored suggestions (research section 7). A look-alike
//      the user IGNORED drops the group at ANY confidence: a dismissed idea is neither
//      offered again nor auto-applied. A pending look-alike is refreshed (below the bar)
//      or superseded (applied).
//   2. At or above the bar: create the workspace and move the tabs.
//   3. Below the bar: store a suggestion; move nothing.
import type { PoolClient } from "pg";
import { randomUUID } from "crypto";
import type { AppliedGroup } from "@ai-browser/shared";
import { mapWorkspace, type DbWorkspace } from "../map";
import { jaccard, SAME_GROUP_OVERLAP } from "./fingerprint";
import { MIN_GROUP_SIZE } from "./model";
import type { ValidatedGroup } from "./prompt";
import { findExistingWorkspace, isReservedName } from "./target";

const WORKSPACE_COLUMNS = "id, user_id, name, emoji, status, created_at, updated_at";

export interface ApplyResult {
  applied: AppliedGroup[];
  /** Workspaces this call created (never one that already existed). */
  createdWorkspaceIds: string[];
  /** Tabs actually moved. */
  appliedCount: number;
  /** Suggestions created or refreshed. */
  suggestionIds: string[];
}

interface StoredSuggestion {
  id: string;
  status: "pending" | "ignored";
  tab_ref_ids: string[];
}

/**
 * Applies every group at or above `bar`, most confident first, and stores the rest as
 * suggestions. Only a tab that is still in Other and has never been placed is moved
 * (the conditional UPDATE is what lets a change the user made since analysis win).
 * Each moved tab gets an undo-log row and a `reassigned` event.
 */
export async function applyGroups(
  client: PoolClient,
  userId: string,
  runId: string,
  groups: ValidatedGroup[],
  bar: number,
): Promise<ApplyResult> {
  const result: ApplyResult = { applied: [], createdWorkspaceIds: [], appliedCount: 0, suggestionIds: [] };
  const ordered = [...groups].sort((a, b) => b.confidence - a.confidence);

  const stored = (
    await client.query<StoredSuggestion>(
      `SELECT id, status, tab_ref_ids FROM suggestions WHERE user_id = $1 AND status IN ('pending', 'ignored')`,
      [userId],
    )
  ).rows;

  for (const [index, group] of ordered.entries()) {
    // 1. Has the user seen (and maybe dismissed) this group before?
    let pendingMatch: StoredSuggestion | null = null;
    let bestOverlap = 0;
    let dismissed = false;
    for (const s of stored) {
      const overlap = jaccard(group.tabRefIds, s.tab_ref_ids);
      if (overlap < SAME_GROUP_OVERLAP) continue;
      if (s.status === "ignored") dismissed = true;
      else if (overlap > bestOverlap) {
        bestOverlap = overlap;
        pendingMatch = s;
      }
    }
    if (dismissed) continue;

    if (group.confidence >= bar) {
      // 2. Confident: apply it.
      const applied = await applyOne(client, userId, runId, group, `sp_group_${index}`);
      if (!applied) continue;
      result.applied.push(applied.group);
      if (applied.group.created) result.createdWorkspaceIds.push(applied.group.workspace.id);
      result.appliedCount += applied.group.tabRefIds.length;
      if (pendingMatch) {
        // The idea the user was shown is now applied on its own: retire the old suggestion.
        await client.query(
          `UPDATE suggestions SET status = 'withdrawn', resolved_at = now() WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
          [pendingMatch.id, userId],
        );
        stored.splice(stored.indexOf(pendingMatch), 1); // nothing later in this run may match it again
      }
    } else {
      // 3. Unsure: suggest, never move.
      const id = await suggest(client, userId, runId, group, pendingMatch);
      if (id) result.suggestionIds.push(id);
    }
  }
  return result;
}

/** Creates the workspace and moves the tabs, or undoes all of it if too few tabs could move. */
async function applyOne(
  client: PoolClient,
  userId: string,
  runId: string,
  group: ValidatedGroup,
  savepoint: string,
): Promise<{ group: AppliedGroup } | null> {
  if (isReservedName(group.name)) return null; // validation already refuses it; this is a second lock on the door
  await client.query(`SAVEPOINT ${savepoint}`);

  // Join an existing workspace (by the id the model named, or by name) instead of making a near-duplicate.
  const existing = await findExistingWorkspace(client, userId, group);
  let workspace: DbWorkspace;
  if (existing) {
    workspace = existing;
  } else {
    const created = await client.query<DbWorkspace>(
      `INSERT INTO workspaces (id, user_id, name, emoji, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING ${WORKSPACE_COLUMNS}`,
      [randomUUID(), userId, group.name, group.emoji],
    );
    workspace = created.rows[0];
  }

  const moved = await client.query<{ id: string }>(
    `UPDATE tab_refs
     SET workspace_id = $1, placement_source = 'ai'
     WHERE user_id = $2 AND id = ANY($3::uuid[])
       AND workspace_id IS NULL AND placement_source IS NULL
     RETURNING id`,
    [workspace.id, userId, group.tabRefIds],
  );
  const movedIds = moved.rows.map((r) => r.id);

  if (movedIds.length < MIN_GROUP_SIZE) {
    // The user (or another writer) changed too many of these tabs while the model was thinking.
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return null;
  }

  await client.query(
    `INSERT INTO cluster_run_moves (run_id, user_id, tab_ref_id, to_workspace_id)
     SELECT $1::uuid, $2::uuid, unnest($3::uuid[]), $4::uuid`,
    [runId, userId, movedIds, workspace.id],
  );
  await recordReassignments(client, userId, movedIds, workspace.id);
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);

  return { group: { workspace: mapWorkspace(workspace), created: existing === null, tabRefIds: movedIds } };
}

/** Stores (or refreshes) a suggestion for a group the model is not sure about. Returns its id. */
async function suggest(
  client: PoolClient,
  userId: string,
  runId: string,
  group: ValidatedGroup,
  pendingMatch: StoredSuggestion | null,
): Promise<string | null> {
  // Only tabs that are still unplaced can be offered.
  const free = await client.query<{ id: string }>(
    `SELECT id FROM tab_refs
     WHERE user_id = $1 AND id = ANY($2::uuid[]) AND workspace_id IS NULL AND placement_source IS NULL`,
    [userId, group.tabRefIds],
  );
  const tabIds = free.rows.map((r) => r.id);
  if (tabIds.length < MIN_GROUP_SIZE) return null;
  if (isReservedName(group.name)) return null;
  const target = (await findExistingWorkspace(client, userId, group))?.id ?? null;

  if (pendingMatch) {
    const refreshed = await client.query<{ id: string }>(
      `UPDATE suggestions
       SET run_id = $3, name = $4, emoji = $5, target_workspace_id = $6, confidence = $7, tab_ref_ids = $8::uuid[]
       WHERE id = $1 AND user_id = $2 AND status = 'pending'
       RETURNING id`,
      [pendingMatch.id, userId, runId, group.name, group.emoji, target, group.confidence, tabIds],
    );
    return refreshed.rows[0]?.id ?? null;
  }

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO suggestions (id, user_id, run_id, name, emoji, target_workspace_id, confidence, tab_ref_ids, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], 'pending')
     RETURNING id`,
    [randomUUID(), userId, runId, group.name, group.emoji, target, group.confidence, tabIds],
  );
  return inserted.rows[0].id;
}

/** One `reassigned` tab event per tab, carrying the workspace it is now in (null = Other). */
export async function recordReassignments(
  client: PoolClient,
  userId: string,
  tabRefIds: string[],
  workspaceId: string | null,
): Promise<void> {
  if (tabRefIds.length === 0) return;
  await client.query(
    `INSERT INTO tab_events (time, id, user_id, tab_ref_id, chrome_tab_id, url, title, workspace_id, event_type)
     SELECT now(), gen_random_uuid(), t.user_id, t.id, t.chrome_tab_id, t.url, t.title, $3::uuid, 'reassigned'
     FROM tab_refs t
     WHERE t.user_id = $1 AND t.id = ANY($2::uuid[])`,
    [userId, tabRefIds, workspaceId],
  );
}
