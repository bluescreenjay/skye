import { requireUser } from "@/src/auth";
import { query } from "@/src/db";
import { errorJson, json, optionsResponse } from "@/src/json";
import { CLUSTER_RUN_COLUMNS, mapClusterRun, type DbClusterRun } from "@/src/map";

export const runtime = "nodejs";

export function OPTIONS() {
  return optionsResponse();
}

/** One run and the tabs it moved. `stillAiPlaced` is false once the user has moved a tab themselves. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  const { id } = await context.params;

  const found = await query<DbClusterRun>(
    `SELECT ${CLUSTER_RUN_COLUMNS} FROM cluster_runs WHERE id = $1 AND user_id = $2`,
    [id, user!.id],
  );
  if (!found.rows[0]) return errorJson("Run not found.", 404);

  const moves = await query<{ tab_ref_id: string; to_workspace_id: string; still_ai: boolean }>(
    `SELECT m.tab_ref_id, m.to_workspace_id,
            (t.workspace_id = m.to_workspace_id AND t.placement_source = 'ai') AS still_ai
     FROM cluster_run_moves m
     JOIN tab_refs t ON t.id = m.tab_ref_id AND t.user_id = m.user_id
     WHERE m.run_id = $1 AND m.user_id = $2
     ORDER BY m.tab_ref_id`,
    [id, user!.id],
  );
  return json({
    run: mapClusterRun(found.rows[0]),
    moves: moves.rows.map((m) => ({ tabRefId: m.tab_ref_id, toWorkspaceId: m.to_workspace_id, stillAiPlaced: m.still_ai })),
  });
}
