// One click starts one saved run (contracts/http.md POST …/run). Checks happen before anything
// is stored. The job finishes the row; this function returns the pending view at once.
import type { ToolRunView } from "@ai-browser/shared";
import { AgentRequestError } from "../agents/errors";
import { startJob } from "../agents/jobs";
import { query } from "../db";
import { ACTION_RUN_COLUMNS, mapToolRun, type DbActionRun } from "../map";
import type { DbWorkspace } from "../map";
import { loadWorkspaceFacts, toolAllowedFor } from "./access";
import { validateArgs } from "./args";
import {
  ActionRequestError,
  badInput,
  failureFor,
  invalidBody,
  notAvailable,
  notConnected,
  precondition,
  runInProgress,
  tooManyRuns,
  unknownTool,
} from "./errors";
import { serviceLabel } from "./integrations/config";
import { JOB_LIMIT_MS, RUN_LABEL_CHARS } from "./limits";
import { runComposedLoop } from "./loop";
import { getActionModel } from "./model";
import { getTool, type ToolDef } from "./registry";
import { applyRetention, failRun, finishRunSucceeded, insertPendingRun, readToolRun } from "./runs";

let jobLimitOverride: number | null = null;
export function setActionJobLimitMsForTests(ms: number | null): void {
  jobLimitOverride = ms;
}
const jobLimitMs = () => jobLimitOverride ?? JOB_LIMIT_MS;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function missingRequired(tool: ToolDef, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter((name) => args[name] === undefined);
}

export function isComposedRun(tool: ToolDef, args: Record<string, unknown>): boolean {
  if (tool.id === "write_summary" || tool.id === "open_related_tabs" || tool.id === "open_google_searches") return false;
  return missingRequired(tool, args).some((name) => {
    const flags = tool.argFlags[name] ?? {};
    return !flags.visible && !flags.prefillOnly;
  });
}

function needsModel(tool: ToolDef, args: Record<string, unknown>): boolean {
  return tool.id === "write_summary" || isComposedRun(tool, args);
}

function remapInsertError(error: unknown): never {
  if (error instanceof AgentRequestError) {
    if (error.code === "run_in_progress") throw runInProgress();
    if (error.code === "too_many_runs") throw tooManyRuns();
  }
  throw error;
}

export async function startToolRun(
  userId: string,
  workspace: Pick<DbWorkspace, "id" | "name">,
  toolId: string,
  body: { args: Record<string, unknown>; label: string | null },
): Promise<{ run: ToolRunView; mail?: { from: string; subject: string; date: string; excerpt: string }[] }> {
  const tool = getTool(toolId);
  if (!tool) throw unknownTool();

  const loaded = await loadWorkspaceFacts(userId, workspace);
  const access = toolAllowedFor(userId, tool, loaded.facts);
  if (access === "not_available") throw notAvailable();
  if (access === "not_connected" && tool.integration) throw notConnected(serviceLabel(tool.integration));
  if (access === "precondition") {
    const sentence = tool.preconditions(loaded.facts);
    throw precondition(sentence ?? "That action isn't available yet.");
  }

  const args = validateArgs(tool, body.args, { requireVisible: tool.id !== "gmail_send_message" });
  for (const name of Object.keys(body.args)) {
    if (!(name in tool.inputSchema.properties)) throw invalidBody();
  }
  for (const name of missingRequired(tool, args)) {
    const flags = tool.argFlags[name] ?? {};
    if (flags.visible || flags.prefillOnly) {
      throw badInput(`"${name}" has to be filled in before this action can run.`);
    }
  }

  const composed = isComposedRun(tool, args);
  if (needsModel(tool, args)) getActionModel();

  const label = (body.label ?? tool.label).trim().slice(0, RUN_LABEL_CHARS) || tool.label;
  const input = {
    label,
    mode: composed ? "composed" : "direct",
    lockedArgs: Object.keys(args),
    suggestionKey: tool.id,
  };

  let inserted: Awaited<ReturnType<typeof insertPendingRun>>;
  try {
    inserted = await insertPendingRun(userId, workspace.id, tool.id, input);
  } catch (error) {
    remapInsertError(error);
  }
  const pending = await readToolRun(userId, workspace.id, inserted.id);
  if (tool.id === "gmail_search_messages") {
    try {
      const executed = await tool.execute({
        userId,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        args,
        signal: AbortSignal.timeout(15_000),
      });
      await finishRunSucceeded(
        { query },
        inserted.id,
        userId,
        { result: { kind: "mail_search", shown: executed.result.kind === "mail_search" ? executed.result.shown : 0 }, links: [], steps: [], refused: [], stoppedAtLimit: false },
      );
      await applyRetention({ query }, userId, workspace.id, tool.id).catch(() => undefined);
      const run = (await readToolRun(userId, workspace.id, inserted.id)) ?? pending!;
      const mail = (executed as { mail?: { from: string; subject: string; date: string; excerpt: string }[] }).mail ?? [];
      return { run, mail };
    } catch (error) {
      await failRun(inserted.id, userId, failureFor(error));
      return { run: (await readToolRun(userId, workspace.id, inserted.id)) ?? pending! };
    }
  }
  startJob(() => executeToolJob(inserted.id, userId, workspace, tool, args, composed));
  return { run: pending ?? mapPending(inserted.id, tool.id, label) };
}

function mapPending(id: string, toolId: string, label: string): ToolRunView {
  return {
    id,
    toolId,
    state: "running",
    createdAt: new Date().toISOString(),
    label,
    output: null,
    error: null,
    awaitingIntents: null,
  };
}

async function executeToolJob(
  runId: string,
  userId: string,
  workspace: Pick<DbWorkspace, "id" | "name">,
  tool: ToolDef,
  args: Record<string, unknown>,
  composed: boolean,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), jobLimitMs());
  try {
    const loaded = await loadWorkspaceFacts(userId, workspace);
    const executed = composed
      ? await runComposedLoop({
          userId,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          tool,
          lockedArgs: args,
          facts: loaded.facts,
          gathered: loaded.gathered,
          signal: controller.signal,
        })
      : await (async () => {
          const result = await tool.execute({
            userId,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            args,
            signal: controller.signal,
          });
          return { result: result.result, links: result.links ?? [], steps: result.steps ?? [], refused: [], intents: result.intents };
        })();

    if (executed.intents && executed.intents.length > 0) {
      await query(
        `UPDATE action_runs SET output = $3::jsonb
         WHERE id = $1::uuid AND user_id = $2::uuid AND status = 'pending'`,
        [runId, userId, JSON.stringify({ awaiting: { intents: executed.intents, skipped: executed.result.kind === "opened" ? executed.result.skipped : [] } })],
      );
      return;
    }

    await finishRunSucceeded(
      { query },
      runId,
      userId,
      {
        result: executed.result,
        links: executed.links,
        steps: executed.steps,
        refused: executed.refused,
        stoppedAtLimit: false,
      },
    );
    await applyRetention({ query }, userId, workspace.id, tool.id).catch(() => undefined);
  } catch (error) {
    await failRun(runId, userId, failureFor(error, { timedOut: controller.signal.aborted }));
    await applyRetention({ query }, userId, workspace.id, tool.id).catch(() => undefined);
  } finally {
    clearTimeout(timer);
  }
}

export function parseRunBody(body: unknown): { args: Record<string, unknown>; label: string | null } {
  if (!isPlainObject(body)) throw new ActionRequestError(400, "invalid_body", "That request wasn't in the expected form.");
  const args = body.args === undefined ? {} : body.args;
  if (!isPlainObject(args)) throw new ActionRequestError(400, "invalid_body", "That request wasn't in the expected form.");
  if (body.label !== undefined && body.label !== null && typeof body.label !== "string") {
    throw new ActionRequestError(400, "invalid_body", "That request wasn't in the expected form.");
  }
  return { args, label: typeof body.label === "string" ? body.label : null };
}

export async function readPendingRow(runId: string, userId: string, workspaceId: string): Promise<DbActionRun | null> {
  const result = await query<DbActionRun>(
    `SELECT ${ACTION_RUN_COLUMNS} FROM action_runs
     WHERE id = $1::uuid AND user_id = $2::uuid AND workspace_id = $3::uuid LIMIT 1`,
    [runId, userId, workspaceId],
  );
  return result.rows[0] ?? null;
}

export { mapToolRun };
