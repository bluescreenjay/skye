// Two-phase Gmail send: unsent → sending → sent | cancelled | expired.
import type { EmailState, ToolRunView } from "@ai-browser/shared";
import { randomUUID } from "crypto";
import { query } from "../db";
import { ACTION_RUN_COLUMNS, mapToolRun, type DbActionRun } from "../map";
import { isValidRecipient } from "./args";
import { alreadySent, cancelledPreview, expiredPreview, invalidRecipient, notAvailable, notConnected } from "./errors";
import { CONFIRM_WINDOW_MS } from "./limits";
import { getConnector } from "./integrations/connector";
import { isOwner, connectionStatus } from "./integrations/config";
import { applyRetention, failRun, finishRunSucceeded } from "./runs";
import { failureFor } from "./errors";

function previewOf(row: DbActionRun): { to: string | null; subject: string; body: string; state: EmailState; created: number } | null {
  const output = row.output && typeof row.output === "object" ? (row.output as { result?: { kind?: string; to?: string | null; subject?: string; body?: string; state?: EmailState } }) : null;
  const result = output?.result;
  if (!result || result.kind !== "email_preview") return null;
  return {
    to: result.to ?? null,
    subject: result.subject ?? "",
    body: result.body ?? "",
    state: result.state ?? "unsent",
    created: new Date(row.created_at).getTime(),
  };
}

export async function confirmSend(userId: string, workspaceId: string, runId: string, to: string): Promise<ToolRunView> {
  if (!isValidRecipient(to)) throw invalidRecipient();
  if (!isOwner(userId)) throw notAvailable();
  if (connectionStatus("gmail") !== "connected") throw notConnected("Google");

  const row = await query<DbActionRun>(
    `SELECT ${ACTION_RUN_COLUMNS} FROM action_runs
     WHERE id = $1::uuid AND user_id = $2::uuid AND workspace_id = $3::uuid LIMIT 1`,
    [runId, userId, workspaceId],
  );
  const found = row.rows[0];
  if (!found) throw Object.assign(new Error("not found"), { http: 404 });
  const preview = previewOf(found);
  if (!preview) throw Object.assign(new Error("not found"), { http: 404 });
  if (preview.state === "sent" || preview.state === "sending") throw alreadySent();
  if (preview.state === "cancelled") throw cancelledPreview();
  if (preview.state === "expired" || Date.now() - preview.created > CONFIRM_WINDOW_MS) throw expiredPreview();

  const sending = await query(
    `UPDATE action_runs SET output = jsonb_set(output, '{result,state}', '"sending"')
     WHERE id = $1::uuid AND user_id = $2::uuid AND status = 'succeeded'
       AND output->'result'->>'state' = 'unsent'
     RETURNING id`,
    [runId, userId],
  );
  if ((sending.rowCount ?? 0) === 0) throw alreadySent();

  const sendRun = await query<DbActionRun>(
    `INSERT INTO action_runs (id, user_id, workspace_id, action_id, input, status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'gmail_send_message', $4::jsonb, 'pending')
     RETURNING ${ACTION_RUN_COLUMNS}`,
    [randomUUID(), userId, workspaceId, JSON.stringify({ label: "Send email", mode: "confirm", lockedArgs: ["subject", "body"] })],
  );
  const pending = sendRun.rows[0];
  try {
    const result = await getConnector().call("gmail_send_message", { to, subject: preview.subject, body: preview.body }, AbortSignal.timeout(15_000));
    await query(
      `UPDATE action_runs SET output = jsonb_set(output, '{result,state}', '"sent"')
       WHERE id = $1::uuid AND user_id = $2::uuid`,
      [runId, userId],
    );
    await finishRunSucceeded({ query }, pending.id, userId, {
      result: { kind: "created", service: "gmail", what: "message" },
      links: result.links,
      steps: [],
      refused: [],
      stoppedAtLimit: false,
    });
  } catch (error) {
    await query(
      `UPDATE action_runs SET output = jsonb_set(output, '{result,state}', '"unsent"')
       WHERE id = $1::uuid AND user_id = $2::uuid AND output->'result'->>'state' = 'sending'`,
      [runId, userId],
    );
    await failRun(pending.id, userId, failureFor(error));
  }
  await applyRetention({ query }, userId, workspaceId, "gmail_send_message").catch(() => undefined);
  const next = await query<DbActionRun>(`SELECT ${ACTION_RUN_COLUMNS} FROM action_runs WHERE id = $1::uuid AND user_id = $2::uuid LIMIT 1`, [pending.id, userId]);
  return mapToolRun(next.rows[0]);
}

export async function cancelSend(userId: string, workspaceId: string, runId: string): Promise<ToolRunView> {
  const row = await query<DbActionRun>(
    `SELECT ${ACTION_RUN_COLUMNS} FROM action_runs
     WHERE id = $1::uuid AND user_id = $2::uuid AND workspace_id = $3::uuid LIMIT 1`,
    [runId, userId, workspaceId],
  );
  const found = row.rows[0];
  if (!found) throw Object.assign(new Error("not found"), { http: 404 });
  const preview = previewOf(found);
  if (!preview) throw Object.assign(new Error("not found"), { http: 404 });
  if (preview.state === "sent" || preview.state === "sending") throw alreadySent();
  await query(
    `UPDATE action_runs SET output = jsonb_set(output, '{result,state}', '"cancelled"')
     WHERE id = $1::uuid AND user_id = $2::uuid`,
    [runId, userId],
  );
  const next = await query<DbActionRun>(`SELECT ${ACTION_RUN_COLUMNS} FROM action_runs WHERE id = $1::uuid AND user_id = $2::uuid LIMIT 1`, [runId, userId]);
  return mapToolRun(next.rows[0]);
}
