// The run store: agent runs are rows of the existing `action_runs` table (data-model.md). Every
// query filters by `user_id` AND the workspace id. A run is `pending` (shown as "running") until a
// job finishes it, and every finish is conditional on it still being `pending`, so a run that was
// reaped as stale can never be overwritten by a late job. Nothing here logs.
import { randomUUID } from "crypto";
import type { QueryResult, QueryResultRow } from "pg";
import type { AgentEntry, AgentRunInput, AgentRunView } from "@ai-browser/shared";
import { query } from "../db";
import { ACTION_RUN_COLUMNS, mapActionRun, type DbActionRun } from "../map";
import { AGENTS } from "./catalog";
import { runInProgress, TIMED_OUT_MESSAGE } from "./errors";
import { STALE_RUN_SECONDS } from "./limits";

/** Either the pool helper or a transaction's client. */
export type Db = { query: <T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) => Promise<QueryResult<T>> };

/**
 * Marks every run of this person that has been `pending` longer than STALE_RUN_SECONDS as failed
 * (`timed_out`). Called on every read and every press, so a run whose server stopped is never
 * shown as running forever, even if nobody presses anything again (spec FR-011).
 */
export async function reapStale(db: Db, userId: string): Promise<void> {
  await db.query(
    `UPDATE action_runs SET status = 'failed', output = $2::jsonb
     WHERE user_id = $1::uuid AND status = 'pending'
       AND created_at < now() - ($3::text || ' seconds')::interval`,
    [userId, JSON.stringify({ error: { code: "timed_out", message: TIMED_OUT_MESSAGE } }), String(STALE_RUN_SECONDS)],
  );
}

/** Stores a new `pending` run. A second run of the same agent in this workspace is refused by a unique index. */
export async function insertPendingRun(userId: string, workspaceId: string, agentId: string, input: AgentRunInput): Promise<AgentRunView> {
  try {
    const result = await query<DbActionRun>(
      `INSERT INTO action_runs (id, user_id, workspace_id, action_id, input, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, 'pending')
       RETURNING ${ACTION_RUN_COLUMNS}`,
      [randomUUID(), userId, workspaceId, agentId, JSON.stringify(input)],
    );
    return mapActionRun(result.rows[0]);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw runInProgress();
    throw error;
  }
}

/** Marks a run succeeded, only if it is still `pending`. Returns whether it changed a row. */
export async function finishRunSucceeded(db: Db, runId: string, userId: string, output: unknown): Promise<boolean> {
  const result = await db.query(
    `UPDATE action_runs SET status = 'succeeded', output = $3::jsonb
     WHERE id = $1::uuid AND user_id = $2::uuid AND status = 'pending'
     RETURNING id`,
    [runId, userId, JSON.stringify(output)],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Marks a run failed with a fixed sentence, only if it is still `pending`. Never throws. */
export async function failRun(runId: string, userId: string, error: { code: string; message: string }): Promise<void> {
  await query(
    `UPDATE action_runs SET status = 'failed', output = $3::jsonb
     WHERE id = $1::uuid AND user_id = $2::uuid AND status = 'pending'`,
    [runId, userId, JSON.stringify({ error })],
  ).catch(() => undefined); // never mask the original error
}

/** The catalog with each agent's latest finished run, its running run, and its latest failure when newer. */
export async function readEntries(userId: string, workspaceId: string): Promise<AgentEntry[]> {
  await reapStale({ query }, userId);
  const result = await query<DbActionRun>(
    `SELECT ${ACTION_RUN_COLUMNS} FROM action_runs
     WHERE user_id = $1::uuid AND workspace_id = $2::uuid
     ORDER BY created_at DESC, id DESC LIMIT 60`,
    [userId, workspaceId],
  );
  const runs = result.rows.map(mapActionRun); // newest first
  return AGENTS.map((agent) => {
    const mine = runs.filter((run) => run.agentId === agent.id);
    const latest = mine.find((run) => run.state === "succeeded") ?? null;
    const running = mine.find((run) => run.state === "running") ?? null;
    const failed = mine.find((run) => run.state === "failed") ?? null;
    const lastFailed = failed && (!latest || failed.createdAt > latest.createdAt) ? failed : null;
    return { id: agent.id, name: agent.name, description: agent.description, kind: agent.kind, latest, running, lastFailed };
  });
}
