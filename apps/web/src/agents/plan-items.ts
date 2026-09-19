// The "next steps" checklist lives in the existing `plan_items` table, and the workspace chat
// already reads it. Every query filters by the person AND the workspace. Nothing here logs.
import type { PlanItem } from "@ai-browser/shared";
import { query } from "../db";
import { mapPlanItem, PLAN_ITEM_COLUMNS, type DbPlanItem } from "../map";
import { MAX_PLAN_ITEMS } from "./limits";

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
