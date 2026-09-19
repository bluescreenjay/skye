// One clustering run for one user (data-model.md, "Algorithm"). Order matters:
//   0. get the model (no key -> nothing is written)
//   1. guard: reap a stale run, then insert the one allowed `running` row
//   2. read active workspaces and the unplaced candidate tabs
//   3. skip when nothing changed; finish quietly when there is too little to group
//   4. ask the model, with NO database transaction open
//   5. validate its answer
//   6. apply in one transaction, settle, mark the run succeeded
// Any failure after step 1 marks the run failed and changes nothing else.
import type { QueryResult, QueryResultRow } from "pg";
import type { AppliedGroup, ClusterRun, SuggestionView } from "@ai-browser/shared";
import { query, withTransaction } from "../db";
import { BudgetExceededError, ModelError, ModelUnconfiguredError } from "../llm/errors";
import { CLUSTER_RUN_COLUMNS, mapClusterRun, type DbClusterRun } from "../map";
import { applyGroups } from "./apply";
import { fingerprint } from "./fingerprint";
import { confidenceBar, getModel, MAX_TABS_PER_RUN, MIN_GROUP_SIZE } from "./model";
import { buildRequest, validateAnswer, type Candidate, type WorkspaceRef } from "./prompt";
import { getSuggestionViews, withdrawStale } from "./suggestions";

/** A run left in `running` longer than this is treated as crashed. */
const STALE_RUN_SECONDS = 120;

/** This user already has a run in flight. */
export class RunInProgress extends Error {
  constructor() {
    super("A clustering run is already in progress.");
    this.name = "RunInProgress";
  }
}

export interface RunOutcome {
  skipped: boolean;
  reason?: "unchanged";
  /** The run that ran, or (when skipped) the latest one for reference. */
  run: ClusterRun | null;
  applied: AppliedGroup[];
  suggestions: SuggestionView[];
  leftOut: number;
}

/** Either the pool helper or a transaction's client. */
type Db = { query: <T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) => Promise<QueryResult<T>> };

/** Unplaced candidates: in Other, never placed, a web address; open tabs first, then newest. */
export async function readCandidates(db: Db, userId: string): Promise<{ candidates: Candidate[]; total: number }> {
  const result = await db.query<{ id: string; url: string; title: string; snippet: string; total: string }>(
    `SELECT id, url, title, snippet, count(*) OVER () AS total
     FROM tab_refs
     WHERE user_id = $1 AND workspace_id IS NULL AND placement_source IS NULL AND url ~* '^https?://'
     ORDER BY (chrome_tab_id IS NOT NULL) DESC, last_seen_at DESC, id
     LIMIT $2`,
    [userId, MAX_TABS_PER_RUN],
  );
  const candidates = result.rows.map(({ id, url, title, snippet }) => ({ id, url, title, snippet }));
  return { candidates, total: result.rows.length > 0 ? Number(result.rows[0].total) : 0 };
}

export async function readWorkspaces(db: Db, userId: string): Promise<WorkspaceRef[]> {
  const result = await db.query<WorkspaceRef>(
    `SELECT id, name FROM workspaces WHERE user_id = $1 AND status <> 'archived' ORDER BY created_at, id`,
    [userId],
  );
  return result.rows;
}

async function latestRun(userId: string, statuses: string[]): Promise<DbClusterRun & { settled_fingerprint: string | null } | null> {
  const result = await query<DbClusterRun & { settled_fingerprint: string | null }>(
    `SELECT ${CLUSTER_RUN_COLUMNS}, settled_fingerprint FROM cluster_runs
     WHERE user_id = $1 AND status = ANY($2::text[])
     ORDER BY started_at DESC LIMIT 1`,
    [userId, statuses],
  );
  return result.rows[0] ?? null;
}

async function fail(runId: string, userId: string, message: string): Promise<void> {
  await query(
    `UPDATE cluster_runs SET status = 'failed', error = $3, finished_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'running'`,
    [runId, userId, message],
  ).catch(() => undefined); // never mask the original error
}

export async function runClustering(userId: string, options: { force?: boolean } = {}): Promise<RunOutcome> {
  // 0. Nothing is written if there is no key.
  const model = getModel();

  // 1. Guard.
  await query(
    `UPDATE cluster_runs SET status = 'failed', error = 'The run timed out.', finished_at = now()
     WHERE user_id = $1 AND status = 'running' AND started_at < now() - ($2 || ' seconds')::interval`,
    [userId, String(STALE_RUN_SECONDS)],
  );
  const runId = crypto.randomUUID();
  try {
    await query(`INSERT INTO cluster_runs (id, user_id, status) VALUES ($1, $2, 'running')`, [runId, userId]);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new RunInProgress();
    throw error;
  }

  try {
    // 2. Read.
    const workspaces = await readWorkspaces({ query }, userId);
    const { candidates, total } = await readCandidates({ query }, userId);
    const leftOut = Math.max(0, total - candidates.length);
    const before = fingerprint(candidates, workspaces);

    // 3. Skip, or finish early.
    if (!options.force) {
      const previous = await latestRun(userId, ["succeeded", "undone"]);
      if (previous && previous.settled_fingerprint === before) {
        await query(`DELETE FROM cluster_runs WHERE id = $1 AND user_id = $2`, [runId, userId]);
        return { skipped: true, reason: "unchanged", run: mapClusterRun(previous), applied: [], suggestions: [], leftOut };
      }
    }
    if (candidates.length < MIN_GROUP_SIZE) {
      const run = await finish(runId, userId, { considered: candidates.length, leftOut, applied: 0, suggestions: 0, discarded: 0, before, after: before, created: [] });
      return { skipped: false, run, applied: [], suggestions: [], leftOut };
    }

    // 4. Ask the model. No transaction is open while we wait.
    const { input, idMap } = buildRequest(candidates, workspaces);
    const answer = await model.propose(input);

    // 5. Validate.
    const { groups, discarded } = validateAnswer(answer, idMap, workspaces);

    // 6. Apply, settle, finish.
    const outcome = await withTransaction(async (client) => {
      const applied = await applyGroups(client, userId, runId, groups, confidenceBar());
      await withdrawStale(client, userId); // suggestions whose tabs were just placed can no longer be offered
      const after = fingerprint((await readCandidates(client, userId)).candidates, await readWorkspaces(client, userId));
      const run = await finish(
        runId,
        userId,
        {
          considered: candidates.length,
          leftOut,
          applied: applied.appliedCount,
          suggestions: applied.suggestionIds.length,
          discarded,
          before,
          after,
          created: applied.createdWorkspaceIds,
        },
        client,
      );
      return { run, applied: applied.applied, suggestionIds: applied.suggestionIds };
    });
    const suggestions = await getSuggestionViews({ query }, userId, outcome.suggestionIds);

    console.info("[cluster] run finished", {
      runId,
      considered: candidates.length,
      applied: outcome.run.appliedCount,
      suggestions: outcome.run.suggestionCount,
      discarded,
    });
    return { skipped: false, run: outcome.run, applied: outcome.applied, suggestions, leftOut };
  } catch (error) {
    if (error instanceof ModelError || error instanceof BudgetExceededError || error instanceof ModelUnconfiguredError) {
      await fail(runId, userId, error.message); // typed errors carry generic, safe messages
      (error as { runId?: string }).runId = runId;
    } else {
      await fail(runId, userId, "The clustering run failed."); // never the raw message: it could hold SQL or data
    }
    throw error;
  }
}

async function finish(
  runId: string,
  userId: string,
  r: { considered: number; leftOut: number; applied: number; suggestions: number; discarded: number; before: string; after: string; created: string[] },
  db: Db = { query },
): Promise<ClusterRun> {
  const result = await db.query<DbClusterRun>(
    `UPDATE cluster_runs
     SET status = 'succeeded', finished_at = now(),
         considered_count = $3, left_out_count = $4, applied_count = $5, suggestion_count = $6, discarded_count = $7,
         input_fingerprint = $8, settled_fingerprint = $9, created_workspace_ids = $10::uuid[]
     WHERE id = $1 AND user_id = $2
     RETURNING ${CLUSTER_RUN_COLUMNS}`,
    [runId, userId, r.considered, r.leftOut, r.applied, r.suggestions, r.discarded, r.before, r.after, r.created],
  );
  return mapClusterRun(result.rows[0]);
}
