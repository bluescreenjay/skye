// The client side of workspace action tools (feature 010b), shared by every screen that shows
// the actions group. Pure logic: no React and no chrome.*. Types come from @ai-browser/shared.
import type {
  ActionSuggestion,
  BrowserIntent,
  IntentReport,
  SuggestionSet,
  ToolRunView,
  WorkspaceActions,
} from "@ai-browser/shared";
import type { Config } from "../config";

export interface ActionRequestOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export const ACTIONS_POLL_MS = 3000;

const headers = (config: Config): Record<string, string> => ({
  Authorization: `Bearer ${config.deviceToken}`,
  "Content-Type": "application/json",
});

const workspaceUrl = (config: Config, workspaceId: string) =>
  `${config.apiBaseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}`;

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const isString = (value: unknown): value is string => typeof value === "string";

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  try {
    return asObject(await response.json());
  } catch {
    return {};
  }
}

function isSuggestion(value: unknown): value is ActionSuggestion {
  const item = asObject(value);
  return isString(item.id) && isString(item.toolId) && isString(item.label) && isString(item.reason);
}

function isRun(value: unknown): value is ToolRunView {
  const run = asObject(value);
  return isString(run.id) && isString(run.toolId) && (run.state === "running" || run.state === "succeeded" || run.state === "failed");
}

export async function suggestActions(
  config: Config,
  workspaceId: string,
  options: ActionRequestOptions & { force?: boolean } = {},
): Promise<SuggestionSet | null> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${workspaceUrl(config, workspaceId)}/actions/suggest`, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({ force: options.force === true }),
      signal: options.signal,
    });
    if (!response.ok) return null;
    const body = asObject(await response.json());
    if (body.status !== "ok" && body.status !== "failed") return null;
    const suggestions = Array.isArray(body.suggestions) ? body.suggestions.filter(isSuggestion) : [];
    return {
      status: body.status,
      suggestions,
      generatedAt: isString(body.generatedAt) ? body.generatedAt : new Date().toISOString(),
      reused: body.reused === true,
      note: isString(body.note) ? body.note : null,
    };
  } catch {
    return null;
  }
}

export async function listActions(
  config: Config,
  workspaceId: string,
  options: ActionRequestOptions = {},
): Promise<WorkspaceActions | null> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${workspaceUrl(config, workspaceId)}/actions`, {
      headers: headers(config),
      signal: options.signal,
    });
    if (!response.ok) return null;
    const body = asObject(await response.json());
    const runs = Array.isArray(body.runs) ? body.runs.filter(isRun) : [];
    return {
      summary: body.summary && typeof body.summary === "object" ? (body.summary as WorkspaceActions["summary"]) : null,
      queries: Array.isArray(body.queries) ? body.queries.filter(isString) : [],
      refsCount: typeof body.refsCount === "number" ? body.refsCount : 0,
      runs,
    };
  } catch {
    return null;
  }
}

export type RunOutcome =
  | { kind: "started"; run: ToolRunView }
  | { kind: "mail"; run: ToolRunView; mail: unknown }
  | { kind: "already_running" }
  | { kind: "refused"; status: number; code: string | null; message: string }
  | { kind: "unreachable" };

export async function runTool(
  config: Config,
  workspaceId: string,
  toolId: string,
  body: { args: Record<string, unknown>; label: string },
  options: ActionRequestOptions = {},
): Promise<RunOutcome> {
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${workspaceUrl(config, workspaceId)}/actions/${encodeURIComponent(toolId)}/run`, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch {
    return { kind: "unreachable" };
  }
  const json = await jsonOf(response);
  if ((response.status === 202 || response.status === 200) && isRun(json.run)) {
    if (response.status === 200 && json.mail) return { kind: "mail", run: json.run, mail: json.mail };
    return { kind: "started", run: json.run };
  }
  const code = isString(json.code) ? json.code : null;
  if (response.status === 409 && code === "run_in_progress") return { kind: "already_running" };
  const message = isString(json.error) && json.error.trim() ? json.error.trim() : "the action could not start — try again";
  return { kind: "refused", status: response.status, code, message };
}

export async function reportIntent(
  config: Config,
  workspaceId: string,
  runId: string,
  intentId: string,
  body: IntentReport,
  options: ActionRequestOptions = {},
): Promise<ToolRunView | null> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(
      `${workspaceUrl(config, workspaceId)}/actions/runs/${encodeURIComponent(runId)}/intents/${encodeURIComponent(intentId)}`,
      { method: "POST", headers: headers(config), body: JSON.stringify(body), signal: options.signal },
    );
    if (!response.ok) return null;
    const json = await jsonOf(response);
    return isRun(json.run) ? json.run : null;
  } catch {
    return null;
  }
}

export async function confirmSend(
  config: Config,
  workspaceId: string,
  runId: string,
  to: string,
  options: ActionRequestOptions = {},
): Promise<RunOutcome> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${workspaceUrl(config, workspaceId)}/actions/runs/${encodeURIComponent(runId)}/confirm`, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({ to }),
      signal: options.signal,
    });
    const json = await jsonOf(response);
    if (response.ok && isRun(json.run)) return { kind: "started", run: json.run };
    const code = isString(json.code) ? json.code : null;
    const message = isString(json.error) && json.error.trim() ? json.error.trim() : "could not send";
    return { kind: "refused", status: response.status, code, message };
  } catch {
    return { kind: "unreachable" };
  }
}

export async function cancelSend(
  config: Config,
  workspaceId: string,
  runId: string,
  options: ActionRequestOptions = {},
): Promise<ToolRunView | null> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${workspaceUrl(config, workspaceId)}/actions/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      headers: headers(config),
      signal: options.signal,
    });
    if (!response.ok) return null;
    const json = await jsonOf(response);
    return isRun(json.run) ? json.run : null;
  } catch {
    return null;
  }
}

export const shouldPoll = (runs: ToolRunView[]): boolean => runs.some((run) => run.state === "running");

export function suggestionKey(item: ActionSuggestion): string {
  return `${item.toolId}:${item.id}`;
}

/**
 * Keep the buttons under the cursor. When the person is hovering the group, keep the current set
 * and offer a swap; otherwise replace with the next set.
 */
export function stableSwap(
  current: ActionSuggestion[],
  next: ActionSuggestion[],
  hovering: boolean,
): { suggestions: ActionSuggestion[]; offerNew: boolean } {
  if (!hovering) return { suggestions: next, offerNew: false };
  const currentKey = current.map(suggestionKey).join("|");
  const nextKey = next.map(suggestionKey).join("|");
  if (currentKey === nextKey) return { suggestions: current, offerNew: false };
  return { suggestions: current, offerNew: true };
}

export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function sessionOwned(runId: string, started: ReadonlySet<string>): boolean {
  return started.has(runId);
}

export function intentsToExecute(run: ToolRunView, started: ReadonlySet<string>): BrowserIntent[] {
  if (!sessionOwned(run.id, started) || !run.awaitingIntents) return [];
  return run.awaitingIntents;
}

export function resultLines(run: ToolRunView): string[] {
  if (run.state === "failed") return [run.error?.message ?? "failed"];
  const output = run.output;
  if (!output) return run.state === "running" ? ["running"] : [];
  const result = output.result;
  switch (result.kind) {
    case "text":
    case "copy":
      return [result.text];
    case "summary":
      return [result.text];
    case "file":
      return [`${result.filename} (${result.bytes} bytes)`];
    case "opened":
      return [`opened ${result.opened}; failed ${result.failed}; placed ${result.placed ?? 0}`];
    case "saved":
      return [`saved ${result.added}; skipped ${result.skippedDuplicates}; refused ${result.refused}`];
    case "created":
      return [`created ${result.what}`];
    case "search":
      return result.items.map((item) => item.title);
    case "email_preview":
      return [result.subject, result.body];
    case "mail_search":
      return [`${result.shown} messages were shown; they are not kept`];
  }
}

export function isValidRecipient(to: string): boolean {
  const trimmed = to.trim();
  if (!trimmed || /[,\r\n<>()\s]/.test(trimmed)) return false;
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(
    trimmed,
  );
}

export type IntentCounts = { opened: number; failed: number; placed: number };
