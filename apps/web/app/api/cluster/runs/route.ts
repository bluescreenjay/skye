import { requireUser } from "@/src/auth";
import { query } from "@/src/db";
import { errorJson, json, optionsResponse } from "@/src/json";
import { BudgetExceededError, ModelError, ModelUnconfiguredError } from "@/src/llm/errors";
import { CLUSTER_RUN_COLUMNS, mapClusterRun, type DbClusterRun } from "@/src/map";
import { RunInProgress, runClustering } from "@/src/cluster/run";

export const runtime = "nodejs";
// A run waits on the AI service; the client itself gives up after 25 s (src/llm/gemini.ts).
export const maxDuration = 60;

export function OPTIONS() {
  return optionsResponse();
}

/** Run clustering now for the authenticated user (contracts/http.md, POST /api/cluster/runs). */
export async function POST(request: Request) {
  const { user, error } = await requireUser(request);
  if (error) return error;

  // The body is optional: `{ "force": true }` skips the "nothing changed" check.
  let force = false;
  const text = await request.text();
  if (text.trim() !== "") {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return errorJson("Invalid JSON", 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return errorJson("body must be a JSON object", 400);
    }
    const value = (body as { force?: unknown }).force;
    if (value !== undefined && typeof value !== "boolean") return errorJson("force must be a boolean", 400);
    force = value === true;
  }

  try {
    const outcome = await runClustering(user!.id, { force });
    return json(outcome);
  } catch (err) {
    const runId = (err as { runId?: string }).runId;
    if (err instanceof RunInProgress) return json({ error: err.message, code: "run_in_progress" }, 409);
    if (err instanceof BudgetExceededError) return json({ error: err.message, code: "budget_exhausted", runId }, 429);
    if (err instanceof ModelError) return json({ error: err.message, code: "model_error", runId }, 502);
    if (err instanceof ModelUnconfiguredError) return json({ error: err.message, code: "model_unconfigured" }, 503);
    // Never log the error object: a database error can carry query text or values.
    console.error("[cluster] unexpected failure", (err as Error)?.name ?? "Error");
    return errorJson("Clustering failed", 500);
  }
}

/** This user's runs, newest first. */
export async function GET(request: Request) {
  const { user, error } = await requireUser(request);
  if (error) return error;

  const raw = Number(new URL(request.url).searchParams.get("limit") ?? 20);
  const limit = Number.isInteger(raw) && raw >= 1 ? Math.min(raw, 50) : 20;
  const result = await query<DbClusterRun>(
    `SELECT ${CLUSTER_RUN_COLUMNS} FROM cluster_runs WHERE user_id = $1 ORDER BY started_at DESC LIMIT $2`,
    [user!.id, limit],
  );
  return json({ runs: result.rows.map(mapClusterRun) });
}
