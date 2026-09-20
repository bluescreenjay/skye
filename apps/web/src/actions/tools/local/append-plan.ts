import { randomUUID } from "crypto";
import { withTransaction } from "../../../db";
import { listPlanItems } from "../../../agents/plan-items";
import { MAX_PLAN_ITEMS } from "../../../agents/limits";
import type { ToolExecuteContext, ToolExecuteResult } from "../../registry";

export async function executeAppendPlan(ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
  const items = Array.isArray(ctx.args.items) ? (ctx.args.items as string[]) : [];
  const existing = await listPlanItems(ctx.userId, ctx.workspaceId);
  const seen = new Set(existing.map((item) => item.text.trim().toLowerCase()));
  let remaining = MAX_PLAN_ITEMS - existing.length;
  let added = 0;
  let skippedDuplicates = 0;
  let refused = 0;
  const next: { text: string; sort: number }[] = [];
  let sort = existing.reduce((max, item) => Math.max(max, item.sortOrder), -1) + 1;
  for (const raw of items) {
    const text = raw.trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) {
      skippedDuplicates += 1;
      continue;
    }
    if (remaining <= 0) {
      refused += 1;
      continue;
    }
    seen.add(key);
    next.push({ text, sort });
    sort += 1;
    remaining -= 1;
    added += 1;
  }
  if (next.length > 0) {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO plan_items (id, user_id, workspace_id, text, done, sort_order)
         SELECT n.id, $1::uuid, $2::uuid, n.text, false, n.sort_order
         FROM unnest($3::uuid[], $4::text[], $5::int[]) AS n(id, text, sort_order)`,
        [ctx.userId, ctx.workspaceId, next.map(() => randomUUID()), next.map((item) => item.text), next.map((item) => item.sort)],
      );
    });
  }
  return { result: { kind: "saved", what: "plan_items", added, skippedDuplicates, refused } };
}
