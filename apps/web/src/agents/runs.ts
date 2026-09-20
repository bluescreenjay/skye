// The run store: agent runs are rows of the existing `action_runs` table (data-model.md). Every
// query filters by `user_id` AND the workspace id. A run is `pending` (shown as "running") until a
// job finishes it, and every finish is conditional on it still being `pending`, so a run that was
// reaped as stale can never be overwritten by a late job. Nothing here logs.
import { randomUUID } from "crypto";
import type { QueryResult, QueryResultRow } from "pg";
import type { AgentEntry, AgentRunView } from "@ai-browser/shared";
import { query, withTransaction } from "../db";
import { ACTION_RUN_COLUMNS, mapActionRun, type DbActionRun } from "../map";
import { AGENT_IDS, AGENTS } from "./catalog";
import { invalidCursor, runInProgress, tooManyRuns, TIMED_OUT_MESSAGE } from "./errors";
import { KEEP_RUNS, MAX_RUNNING_PER_USER, STALE_RUN_SECONDS } from "./limits";

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

/**
 * Stores a new `pending` run. First any of this person's runs that have been pending too long are
 * marked failed, so a crashed run never blocks anything. Then a person who already has
 * MAX_RUNNING_PER_USER runs going is refused (spec FR-044), and a second run of the same agent in
 * this workspace is refused by a unique index. The count and the insert happen under one lock per
 * person, so presses that arrive together cannot both slip in under the limit.
 */
export async function insertPendingRun(userId: string, workspaceId: string, agentId: string, input: object): Promise<AgentRunView> {
  await reapStale({ query }, userId);
  try {
    return await withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [`agent-runs:${userId}`]);
      const running = await client.query<{ n: string }>("SELECT count(*) AS n FROM action_runs WHERE user_id = $1::uuid AND status = 'pending'", [userId]);
      if (Number(running.rows[0].n) >= MAX_RUNNING_PER_USER) throw tooManyRuns();
      // Checked here, under the lock, so the normal "already running" answer is not a database error
      // (an error inside a transaction is costly); the unique index below is only the backstop.
      const same = await client.query(
        "SELECT 1 FROM action_runs WHERE user_id = $1::uuid AND workspace_id = $2::uuid AND action_id = $3 AND status = 'pending' LIMIT 1",
        [userId, workspaceId, agentId],
      );
      if ((same.rowCount ?? 0) > 0) throw runInProgress();
      const result = await client.query<DbActionRun>(
        `INSERT INTO action_runs (id, user_id, workspace_id, action_id, input, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, 'pending')
         RETURNING ${ACTION_RUN_COLUMNS}`,
        [randomUUID(), userId, workspaceId, agentId, JSON.stringify(input)],
      );
      return mapActionRun(result.rows[0]);
    });
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
export async function failRun(
  runId: string,
  userId: string,
  error: { code: string; message: string; partial?: string | null },
): Promise<void> {
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
     WHERE user_id = $1::uuid AND workspace_id = $2::uuid AND action_id = ANY($3::text[])
     ORDER BY created_at DESC, id DESC LIMIT 60`,
    [userId, workspaceId, AGENT_IDS],
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

/**
 * Keeps this agent's latest KEEP_RUNS runs in this workspace and removes the rest (spec FR-043). Two
 * things are never removed: a run that is still `pending`, and the newest `succeeded` run, so a
 * streak of failures cannot erase the last good result (a workspace may briefly hold one run over).
 * Called after every finish, either way.
 */
export async function applyRetention(db: Db, userId: string, workspaceId: string, agentId: string): Promise<void> {
  await db.query(
    `DELETE FROM action_runs r
     WHERE r.user_id = $1::uuid AND r.workspace_id = $2::uuid AND r.action_id = $3
       AND r.status <> 'pending'
       AND r.id NOT IN (
         SELECT id FROM action_runs
         WHERE user_id = $1::uuid AND workspace_id = $2::uuid AND action_id = $3
         ORDER BY created_at DESC, id DESC LIMIT $4::int)
       AND r.id IS DISTINCT FROM (
         SELECT id FROM action_runs
         WHERE user_id = $1::uuid AND workspace_id = $2::uuid AND action_id = $3 AND status = 'succeeded'
         ORDER BY created_at DESC, id DESC LIMIT 1)`,
    [userId, workspaceId, agentId, KEEP_RUNS],
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One agent's stored runs in this workspace, newest first, at most `limit`. `beforeId` returns only
 * runs older than that one; it must be a run of this agent in this workspace, otherwise the answer is
 * `null` (a bad cursor). The page position is a keyset on `(created_at, id)` taken from a subquery on
 * the cursor run, so timestamps are never rounded through a JavaScript Date. Reaps stale runs first,
 * like `readEntries`.
 */
export async function listRuns(
  userId: string,
  workspaceId: string,
  agentId: string,
  options: { limit: number; beforeId?: string },
): Promise<{ runs: AgentRunView[]; hasMore: boolean } | null> {
  await reapStale({ query }, userId);
  const { beforeId } = options;
  if (beforeId !== undefined) {
    if (!UUID.test(beforeId)) return null;
    const known = await query(
      "SELECT 1 FROM action_runs WHERE id = $1::uuid AND user_id = $2::uuid AND workspace_id = $3::uuid AND action_id = $4",
      [beforeId, userId, workspaceId, agentId],
    );
    if ((known.rowCount ?? 0) === 0) return null;
  }
  const result = await query<DbActionRun>(
    `SELECT ${ACTION_RUN_COLUMNS} FROM action_runs
     WHERE user_id = $1::uuid AND workspace_id = $2::uuid AND action_id = $3
       AND ($4::uuid IS NULL OR (created_at, id) < (
         SELECT created_at, id FROM action_runs
         WHERE id = $4::uuid AND user_id = $1::uuid AND workspace_id = $2::uuid AND action_id = $3))
     ORDER BY created_at DESC, id DESC
     LIMIT $5::int`,
    [userId, workspaceId, agentId, beforeId ?? null, options.limit + 1],
  );
  return { runs: result.rows.slice(0, options.limit).map(mapActionRun), hasMore: result.rows.length > options.limit };
}
