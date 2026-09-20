// The single most recent change made through the command bar, and Undo
// (specs/011-global-command-bar/data-model.md, "command_undo" and "Undo rules, exactly").
//
// One row per person (the primary key), replaced by the next changing command, gone after 10
// minutes. It holds ids, counts, and the old name of a rename: never a tab title or an address.
// Reversal is guarded: a tab is put back only if it is STILL where the command put it and STILL
// placed by the person; a workspace is archived only if it is empty and untouched; a name is
// restored only if it is still the name the command gave. Nothing is deleted. Nothing here logs.
import type { UndoState } from "@ai-browser/shared";
import { query, withTransaction } from "../db";
import { recordReassignments } from "../cluster/apply";
import { RunNotFound, RunNotUndoable, undoRun } from "../cluster/undo";
import type { Db } from "./context";
import { UNDO_WINDOW_MINUTES } from "./limits";
import * as m from "./messages";

export type UndoKind = UndoState["kind"];

export type UndoPayload =
  | { v: 1; runId: string }
  | {
      v: 1;
      moves: { tabRefId: string; fromWorkspaceId: string | null; fromSource: "ai" | "user" | null; toWorkspaceId: string | null }[];
      createdWorkspaceId?: string;
    }
  | { v: 1; rename: { workspaceId: string; from: string; to: string } };

type Row = { kind: UndoKind; summary: string; payload: UndoPayload; created_at_text: string; expires_at: Date | string; fresh: boolean };

const WINDOW = String(UNDO_WINDOW_MINUTES);

const SELECT_ROW = `SELECT kind, summary, payload, created_at::text AS created_at_text,
        created_at + ($2::text || ' minutes')::interval AS expires_at,
        created_at > now() - ($2::text || ' minutes')::interval AS fresh
      FROM command_undo WHERE user_id = $1::uuid`;

/** The current undo state, or null. A row older than the window is deleted and reported as absent. */
export async function readUndo(db: Db, userId: string): Promise<UndoState | null> {
  const result = await db.query<Row>(SELECT_ROW, [userId, WINDOW]);
  const row = result.rows[0];
  if (!row) return null;
  if (!row.fresh) {
    await db.query(`DELETE FROM command_undo WHERE user_id = $1::uuid AND created_at::text = $2`, [userId, row.created_at_text]);
    return null;
  }
  return { kind: row.kind, summary: row.summary, expiresAt: new Date(row.expires_at).toISOString() };
}

/** Records this change as the one that can be undone, replacing any earlier one and restarting the window. */
export async function recordUndo(db: Db, userId: string, kind: UndoKind, summary: string, payload: UndoPayload): Promise<void> {
  await db.query(
    `INSERT INTO command_undo (user_id, kind, summary, payload, created_at)
     VALUES ($1::uuid, $2, $3, $4::jsonb, now())
     ON CONFLICT (user_id) DO UPDATE
       SET kind = EXCLUDED.kind, summary = EXCLUDED.summary, payload = EXCLUDED.payload, created_at = now()`,
    [userId, kind, summary.slice(0, 200), JSON.stringify(payload)],
  );
}

export async function clearUndo(db: Db, userId: string): Promise<void> {
  await db.query(`DELETE FROM command_undo WHERE user_id = $1::uuid`, [userId]);
}

export interface UndoOutcome {
  /** There was nothing to undo (no row, or it had expired). Nothing changed. */
  nothing: boolean;
  message: string;
  reverted: number;
  kept: number;
}

const NOTHING: UndoOutcome = { nothing: true, message: m.NOTHING_TO_UNDO, reverted: 0, kept: 0 };

/**
 * Reverses the most recent change (spec FR-019). Organize is `undoRun` from feature 004, unchanged;
 * everything else is reversed here under the rules above, in one transaction with the person's lock.
 */
export async function undoLast(userId: string): Promise<UndoOutcome> {
  const first = (await query<Row>(SELECT_ROW, [userId, WINDOW])).rows[0];
  if (!first) return NOTHING;
  if (!first.fresh) {
    await clearUndo({ query }, userId);
    return NOTHING;
  }

  if ("runId" in first.payload) {
    // undoRun runs its own transaction, so it cannot be nested in ours.
    let reverted = 0;
    let kept = 0;
    try {
      const result = await undoRun(userId, first.payload.runId);
      reverted = result.reverted;
      kept = result.keptTabRefIds.length;
    } catch (error) {
      if (!(error instanceof RunNotFound || error instanceof RunNotUndoable)) throw error;
      await query(`DELETE FROM command_undo WHERE user_id = $1::uuid AND created_at::text = $2`, [userId, first.created_at_text]);
      return NOTHING;
    }
    await query(`DELETE FROM command_undo WHERE user_id = $1::uuid AND created_at::text = $2`, [userId, first.created_at_text]);
    return { nothing: false, message: m.undoDone(reverted, kept), reverted, kept };
  }

  return withTransaction(async (client): Promise<UndoOutcome> => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [`command:${userId}`]);
    const locked = (await client.query<Row>(`${SELECT_ROW} FOR UPDATE`, [userId, WINDOW])).rows[0];
    if (!locked || !locked.fresh) return NOTHING;
    const payload = locked.payload;

    if ("rename" in payload) {
      const { workspaceId, from, to } = payload.rename;
      const restored = await client.query(
        `UPDATE workspaces SET name = $3, updated_at = now()
         WHERE id = $2::uuid AND user_id = $1::uuid AND name = $4 AND status <> 'archived'
           AND NOT EXISTS (
             SELECT 1 FROM workspaces o
             WHERE o.user_id = $1::uuid AND o.id <> $2::uuid AND o.status <> 'archived'
               AND lower(btrim(o.name)) = lower(btrim($3)))
         RETURNING id`,
        [userId, workspaceId, from, to],
      );
      await client.query(`DELETE FROM command_undo WHERE user_id = $1::uuid`, [userId]);
      const done = (restored.rowCount ?? 0) > 0;
      return { nothing: false, message: done ? m.undoRenamed(from) : m.undoRenameKept, reverted: done ? 1 : 0, kept: done ? 0 : 1 };
    }

    if (!("moves" in payload)) return NOTHING; // unreachable: every payload is one of the three shapes

    const moves = payload.moves;
    const reverted = await client.query<{ id: string }>(
      `UPDATE tab_refs t SET workspace_id = mv.from_ws, placement_source = mv.from_src
       FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::uuid[]) AS mv(tab_id, from_ws, from_src, to_ws)
       WHERE t.user_id = $1::uuid AND t.id = mv.tab_id
         AND t.workspace_id IS NOT DISTINCT FROM mv.to_ws
         AND t.placement_source = 'user'
       RETURNING t.id`,
      [userId, moves.map((x) => x.tabRefId), moves.map((x) => x.fromWorkspaceId), moves.map((x) => x.fromSource), moves.map((x) => x.toWorkspaceId)],
    );
    const revertedIds = new Set(reverted.rows.map((r) => r.id));
    // One `reassigned` event per reverted tab, carrying the workspace it is back in (null = Other).
    const backTo = new Map<string | null, string[]>();
    for (const move of moves) {
      if (!revertedIds.has(move.tabRefId)) continue;
      backTo.set(move.fromWorkspaceId, [...(backTo.get(move.fromWorkspaceId) ?? []), move.tabRefId]);
    }
    for (const [workspaceId, ids] of backTo) await recordReassignments(client, userId, ids, workspaceId);

    let workspaceKept = false;
    if (payload.createdWorkspaceId) {
      const archived = await client.query(
        `UPDATE workspaces w SET status = 'archived', updated_at = now()
         WHERE w.user_id = $1::uuid AND w.id = $2::uuid AND w.status = 'active' AND w.updated_at = w.created_at
           AND NOT EXISTS (SELECT 1 FROM tab_refs t WHERE t.user_id = w.user_id AND t.workspace_id = w.id)
         RETURNING w.id`,
        [userId, payload.createdWorkspaceId],
      );
      workspaceKept = (archived.rowCount ?? 0) === 0;
    }
    await client.query(`DELETE FROM command_undo WHERE user_id = $1::uuid`, [userId]);
    const kept = moves.length - revertedIds.size;
    const message = m.undoDone(revertedIds.size, kept) + (workspaceKept ? ` ${m.UNDO_WORKSPACE_KEPT}` : "");
    return { nothing: false, message, reverted: revertedIds.size, kept };
  });
}
