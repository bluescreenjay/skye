// The "next steps" checklist lives in the existing `plan_items` table, and the workspace chat
// already reads it. Every query filters by the person AND the workspace. Nothing here logs.
import { randomUUID } from "crypto";
import type { PlanItem } from "@ai-browser/shared";
import { query } from "../db";
import { mapPlanItem, PLAN_ITEM_COLUMNS, type DbPlanItem } from "../map";
import { MAX_PLAN_ITEMS } from "./limits";
import type { Db } from "./runs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The workspace's checklist in order (at most MAX_PLAN_ITEMS). */
export async function listPlanItems(userId: string, workspaceId: string): Promise<PlanItem[]> {
  const result = await query<DbPlanItem>(
    `SELECT ${PLAN_ITEM_COLUMNS} FROM plan_items
     WHERE user_id = $1::uuid AND workspace_id = $2::uuid
     ORDER BY sort_order, id LIMIT $3::int`,
    [userId, workspaceId, MAX_PLAN_ITEMS],
  );
  return result.rows.map(mapPlanItem);
}

/**
 * Replaces the workspace's unticked items with a new proposal, keeping the ticked ones first and in
 * their order (spec FR-016). Runs on the caller's transaction so it commits or rolls back together
 * with the run row. The whole list never exceeds MAX_PLAN_ITEMS.
 */
export async function rewriteChecklist(db: Db, userId: string, workspaceId: string, items: string[]): Promise<PlanItem[]> {
  await db.query(`DELETE FROM plan_items WHERE user_id = $1::uuid AND workspace_id = $2::uuid AND NOT done`, [userId, workspaceId]);
  // Only the ticked items are left: number them 0..k-1 in their existing order.
  const renumbered = await db.query<{ n: string }>(
    `WITH numbered AS (
       SELECT id, row_number() OVER (ORDER BY sort_order, id) - 1 AS position
       FROM plan_items WHERE user_id = $1::uuid AND workspace_id = $2::uuid
     ), updated AS (
       UPDATE plan_items p SET sort_order = numbered.position
       FROM numbered WHERE p.id = numbered.id AND p.user_id = $1::uuid AND p.workspace_id = $2::uuid
       RETURNING p.id
     )
     SELECT count(*) AS n FROM updated`,
    [userId, workspaceId],
  );
  const kept = Number(renumbered.rows[0].n);
  const fresh = items.slice(0, Math.max(0, MAX_PLAN_ITEMS - kept));
  if (fresh.length > 0) {
    await db.query(
      `INSERT INTO plan_items (id, user_id, workspace_id, text, done, sort_order)
       SELECT n.id, $1::uuid, $2::uuid, n.text, false, n.sort_order
       FROM unnest($3::uuid[], $4::text[], $5::int[]) AS n(id, text, sort_order)`,
      [userId, workspaceId, fresh.map(() => randomUUID()), fresh, fresh.map((_, i) => kept + i)],
    );
  }
  const result = await db.query<DbPlanItem>(
    `SELECT ${PLAN_ITEM_COLUMNS} FROM plan_items
     WHERE user_id = $1::uuid AND workspace_id = $2::uuid ORDER BY sort_order, id`,
    [userId, workspaceId],
  );
  return result.rows.map(mapPlanItem);
}

/** Ticks or unticks one item of this person's workspace. `null` when there is no such item (a non-UUID id never reaches the database). */
export async function tickPlanItem(userId: string, workspaceId: string, itemId: string, done: boolean): Promise<PlanItem | null> {
  if (!UUID.test(itemId)) return null;
  const result = await query<DbPlanItem>(
    `UPDATE plan_items SET done = $4::boolean
     WHERE id = $1::uuid AND user_id = $2::uuid AND workspace_id = $3::uuid
     RETURNING ${PLAN_ITEM_COLUMNS}`,
    [itemId, userId, workspaceId, done],
  );
  return result.rows[0] ? mapPlanItem(result.rows[0]) : null;
}
