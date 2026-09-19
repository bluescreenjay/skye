// Undo a clustering run (data-model.md, "Undo a run"; FR-010). The rules that keep it safe:
//  - only a tab that is STILL where the run put it and STILL ai-placed is reverted, so a
//    tab the user moved since keeps the user's placement;
//  - a workspace the run created is archived only if it is now empty and untouched
//    (updated_at = created_at, so a rename or any edit keeps it); nothing is deleted;
//  - undoing again is a harmless no-op.
import type { ClusterRun } from "@ai-browser/shared";
import { withTransaction } from "../db";
import { CLUSTER_RUN_COLUMNS, mapClusterRun, type DbClusterRun } from "../map";
import { recordReassignments } from "./apply";
import { fingerprint } from "./fingerprint";
import { readCandidates, readWorkspaces } from "./run";

export class RunNotFound extends Error {
  constructor() {
    super("Run not found.");
    this.name = "RunNotFound";
  }
}
export class RunNotUndoable extends Error {
  constructor() {
    super("Only a finished run can be undone.");
    this.name = "RunNotUndoable";
  }
}

export interface UndoResult {
  run: ClusterRun;
  /** Tabs put back in Other. */
  reverted: number;
  /** Tabs the run moved that the user has since moved: left exactly where the user put them. */
  keptTabRefIds: string[];
  /** Workspaces the run created that are now empty and untouched. */
  archivedWorkspaceIds: string[];
}

export async function undoRun(userId: string, runId: string): Promise<UndoResult> {
  return withTransaction(async (client) => {
    const found = await client.query<DbClusterRun>(
      `SELECT ${CLUSTER_RUN_COLUMNS} FROM cluster_runs WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [runId, userId],
    );
    const row = found.rows[0];
    if (!row) throw new RunNotFound();
    if (row.status === "undone") {
      return { run: mapClusterRun(row), reverted: 0, keptTabRefIds: [], archivedWorkspaceIds: [] };
    }
    if (row.status !== "succeeded") throw new RunNotUndoable();

    const moves = await client.query<{ tab_ref_id: string }>(
      `SELECT tab_ref_id FROM cluster_run_moves WHERE run_id = $1 AND user_id = $2`,
      [runId, userId],
    );

    // Revert only what is still exactly as the run left it.
    const reverted = await client.query<{ id: string }>(
      `UPDATE tab_refs t SET workspace_id = NULL, placement_source = NULL
       FROM cluster_run_moves m
       WHERE m.run_id = $1 AND m.user_id = $2
         AND t.id = m.tab_ref_id AND t.user_id = m.user_id
         AND t.workspace_id = m.to_workspace_id AND t.placement_source = 'ai'
       RETURNING t.id`,
      [runId, userId],
    );
    const revertedIds = reverted.rows.map((r) => r.id);
    const revertedSet = new Set(revertedIds);
    const keptTabRefIds = moves.rows.map((m) => m.tab_ref_id).filter((id) => !revertedSet.has(id));
    await recordReassignments(client, userId, revertedIds, null);

    // Archive the workspaces the run made, if the user has not made them their own.
    const archived = await client.query<{ id: string }>(
      `UPDATE workspaces w SET status = 'archived', updated_at = now()
       WHERE w.user_id = $1 AND w.id = ANY($2::uuid[])
         AND w.status = 'active' AND w.updated_at = w.created_at
         AND NOT EXISTS (SELECT 1 FROM tab_refs t WHERE t.user_id = w.user_id AND t.workspace_id = w.id)
       RETURNING w.id`,
      [userId, row.created_workspace_ids],
    );

    // The state is now different from what the run settled on. Record the new state so a
    // run with nothing new is skipped instead of quietly redoing what the user just undid.
    const settled = fingerprint((await readCandidates(client, userId)).candidates, await readWorkspaces(client, userId));
    const updated = await client.query<DbClusterRun>(
      `UPDATE cluster_runs SET status = 'undone', undone_at = now(), settled_fingerprint = $3
       WHERE id = $1 AND user_id = $2 RETURNING ${CLUSTER_RUN_COLUMNS}`,
      [runId, userId, settled],
    );
    return {
      run: mapClusterRun(updated.rows[0]),
      reverted: revertedIds.length,
      keptTabRefIds,
      archivedWorkspaceIds: archived.rows.map((r) => r.id),
    };
  });
}
