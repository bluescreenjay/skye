// Tool-run views on top of agents/runs.ts (specs/010b-mcp-action-tools/data-model.md).
// Every query filters by user_id AND workspace id. Nothing here logs.
import type { ToolRunView, WorkspaceActions } from "@ai-browser/shared";
import { query } from "../db";
import { ACTION_RUN_COLUMNS, mapToolRun, type DbActionRun } from "../map";
import { allTools } from "./registry";
import { applyRetention, failRun, finishRunSucceeded, insertPendingRun, reapStale } from "../agents/runs";
import { LATEST_RUNS_MAX } from "./limits";
import { countRefs, listQueries, listSummary } from "./notes";

export { applyRetention, failRun, finishRunSucceeded, insertPendingRun, reapStale };

export async function readToolRun(userId: string, workspaceId: string, runId: string): Promise<ToolRunView | null> {
  await reapStale({ query }, userId);
  const result = await query<DbActionRun>(
    `SELECT ${ACTION_RUN_COLUMNS} FROM action_runs
     WHERE id = $1::uuid AND user_id = $2::uuid AND workspace_id = $3::uuid
     LIMIT 1`,
    [runId, userId, workspaceId],
  );
  return result.rows[0] ? mapToolRun(result.rows[0]) : null;
}

export async function readWorkspaceActions(userId: string, workspaceId: string): Promise<WorkspaceActions> {
  await reapStale({ query }, userId);
  const toolIds = allTools().map((tool) => tool.id);
  const result = await query<DbActionRun>(
    `SELECT DISTINCT ON (action_id) ${ACTION_RUN_COLUMNS} FROM action_runs
     WHERE user_id = $1::uuid AND workspace_id = $2::uuid AND action_id = ANY($3::text[])
     ORDER BY action_id, created_at DESC, id DESC`,
    [userId, workspaceId, toolIds],
  );
  const runs = result.rows
    .map(mapToolRun)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1))
    .slice(0, LATEST_RUNS_MAX);
  const [summary, queries, refsCount] = await Promise.all([
    listSummary(userId, workspaceId),
    listQueries(userId, workspaceId),
    countRefs(userId, workspaceId),
  ]);
  return { summary, queries, refsCount, runs };
}
