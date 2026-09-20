// Browser-intent store and report (contracts/http.md POST …/intents/:intentId).
import type { BrowserIntent, IntentReport, ToolRunView } from "@ai-browser/shared";
import { query } from "../db";
import { ACTION_RUN_COLUMNS, mapToolRun, type DbActionRun } from "../map";
import { alreadyReported, invalidBody } from "./errors";
import { BROWSER_FAILED_MESSAGE, failureFor, ToolRunError } from "./errors";
import { applyRetention, failRun, finishRunSucceeded } from "./runs";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseIntentReport(body: unknown): IntentReport {
  if (!isPlainObject(body) || (body.status !== "done" && body.status !== "failed")) throw invalidBody();
  const opened = typeof body.opened === "number" ? body.opened : 0;
  const failed = typeof body.failed === "number" ? body.failed : 0;
  const placed = typeof body.placed === "number" ? body.placed : 0;
  if (![opened, failed, placed].every((n) => Number.isInteger(n) && n >= 0)) throw invalidBody();
  return { status: body.status, opened, failed, placed };
}

export async function reportIntent(
  userId: string,
  workspaceId: string,
  runId: string,
  intentId: string,
  report: IntentReport,
): Promise<ToolRunView> {
  const row = await query<DbActionRun>(
    `SELECT ${ACTION_RUN_COLUMNS} FROM action_runs
     WHERE id = $1::uuid AND user_id = $2::uuid AND workspace_id = $3::uuid LIMIT 1`,
    [runId, userId, workspaceId],
  );
  const found = row.rows[0];
  if (!found) throw Object.assign(new Error("not found"), { http: 404 });
  if (found.status !== "pending") throw alreadyReported();
  const output = found.output && typeof found.output === "object" ? (found.output as Record<string, unknown>) : {};
  const awaiting = output.awaiting && typeof output.awaiting === "object" ? (output.awaiting as { intents?: BrowserIntent[]; skipped?: { url: string; reason: string }[] }) : null;
  const intent = awaiting?.intents?.find((item) => item.id === intentId);
  if (!intent) throw Object.assign(new Error("not found"), { http: 404 });
  if (intent.kind === "open_tabs") {
    const max = intent.urls.length;
    if ((report.opened ?? 0) + (report.failed ?? 0) > max) throw invalidBody();
  }

  const opened = report.opened ?? 0;
  const failed = report.failed ?? 0;
  const placed = report.placed ?? 0;
  const ok = report.status === "done" && (intent.kind === "download" || opened > 0);
  if (!ok) {
    await failRun(runId, userId, failureFor(new ToolRunError("browser_failed", BROWSER_FAILED_MESSAGE)));
    const next = await query<DbActionRun>(`SELECT ${ACTION_RUN_COLUMNS} FROM action_runs WHERE id = $1::uuid AND user_id = $2::uuid LIMIT 1`, [runId, userId]);
    return mapToolRun(next.rows[0]);
  }

  const result =
    intent.kind === "download"
      ? { kind: "file" as const, format: intent.format, filename: intent.filename, bytes: 0 }
      : {
          kind: "opened" as const,
          opened,
          failed,
          skipped: awaiting?.skipped ?? [],
          placed,
        };
  await finishRunSucceeded({ query }, runId, userId, { result, links: [], steps: [], refused: [], stoppedAtLimit: false });
  await applyRetention({ query }, userId, workspaceId, found.action_id).catch(() => undefined);
  const next = await query<DbActionRun>(`SELECT ${ACTION_RUN_COLUMNS} FROM action_runs WHERE id = $1::uuid AND user_id = $2::uuid LIMIT 1`, [runId, userId]);
  return mapToolRun(next.rows[0]);
}
