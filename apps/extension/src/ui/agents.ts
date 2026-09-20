// The client side of workspace agents (feature 010's HTTP contract:
// specs/010-workspace-agents/contracts/http.md), shared by every screen that shows the agents card.
// Pure logic, no React and nothing that touches the browser: a small client that never throws, and the
// helpers the card uses to decide when to poll, how to describe what a result covers, and how to turn a
// result into plain text. Results, titles, quotes, and checklist items are only ever handed back as plain
// strings; the card draws them as text, never as HTML, markdown, links, or images (contract rule 1).
import type {
  AgentEntry,
  AgentResult,
  AgentRunPage,
  AgentRunView,
  AgentSource,
  AgentCoverage,
  AgentNotReadReason,
  PlanItem,
  WorkspaceAgents,
} from "@ai-browser/shared";
import type { Config } from "../config";

export interface AgentRequestOptions {
  signal?: AbortSignal;
  /** Tests only. */
  fetchImpl?: typeof fetch;
}

/** How often the card asks again while some agent is running. It never polls when none is. */
export const POLL_MS = 3000;

/** Addresses in results are cut to this many characters by the server. */
const SHOWN_ADDRESS_CHARS = 200;

const headers = (config: Config): Record<string, string> => ({
  Authorization: `Bearer ${config.deviceToken}`,
  "Content-Type": "application/json",
});

const workspaceUrl = (config: Config, workspaceId: string) => `${config.apiBaseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}`;

const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const isString = (value: unknown): value is string => typeof value === "string";

const RUN_STATES = new Set(["running", "succeeded", "failed"]);
const KINDS = new Set(["text", "comparison", "checklist", "quotes"]);

function isRun(value: unknown): value is AgentRunView {
  const run = asObject(value);
  return isString(run.id) && isString(run.agentId) && RUN_STATES.has(run.state as string) && isString(run.createdAt);
}

const isOptionalRun = (value: unknown) => value === null || isRun(value);

function isEntry(value: unknown): value is AgentEntry {
  const entry = asObject(value);
  return (
    isString(entry.id) &&
    isString(entry.name) &&
    isString(entry.description) &&
    KINDS.has(entry.kind as string) &&
    isOptionalRun(entry.latest) &&
    isOptionalRun(entry.running) &&
    isOptionalRun(entry.lastFailed)
  );
}

function isPlanItem(value: unknown): value is PlanItem {
  const item = asObject(value);
  return isString(item.id) && isString(item.text) && typeof item.done === "boolean" && typeof item.sortOrder === "number";
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  try {
    return asObject(await response.json());
  } catch {
    return {};
  }
}

/** A short sentence for a status the server answered without one of its own. */
function refusalMessage(status: number): string {
  if (status === 401) return "pairing failed — check your device token";
  if (status === 404) return "this workspace is not on the server yet";
  return "the agent could not start — try again";
}

/** The whole card in one read, or null when it cannot be read (refused, unreachable, or not the expected answer). */
export async function readAgents(config: Config, workspaceId: string, options: AgentRequestOptions = {}): Promise<WorkspaceAgents | null> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${workspaceUrl(config, workspaceId)}/agents`, { headers: headers(config), signal: options.signal });
    if (!response.ok) return null;
    const body = asObject(await response.json());
    if (!Array.isArray(body.agents) || !Array.isArray(body.planItems)) return null;
    return { agents: body.agents.filter(isEntry), planItems: body.planItems.filter(isPlanItem) };
  } catch {
    return null;
  }
}

export type PressOutcome =
  /** The run was stored and is running on the server. */
  | { kind: "started"; run: AgentRunView }
  /** This agent is already running for this workspace: not an error to retry. */
  | { kind: "already_running" }
  /** Refused before anything was stored (no tabs, too many runs, no AI key, ...). `message` is a plain sentence. */
  | { kind: "refused"; status: number; code: string | null; message: string }
  /** The server could not be reached. */
  | { kind: "unreachable" };

/** Presses an agent. Never throws: every way it can end is a `PressOutcome`. */
export async function pressAgent(config: Config, workspaceId: string, agentId: string, options: AgentRequestOptions = {}): Promise<PressOutcome> {
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${workspaceUrl(config, workspaceId)}/agents/${encodeURIComponent(agentId)}/run`, {
      method: "POST",
      headers: headers(config),
      signal: options.signal,
    });
  } catch {
    return { kind: "unreachable" };
  }
  const body = await jsonOf(response);
  if (response.status === 202 && isRun(body.run)) return { kind: "started", run: body.run };
  const code = isString(body.code) ? body.code : null;
  if (response.status === 409 && code === "run_in_progress") return { kind: "already_running" };
  const message = response.status !== 202 && isString(body.error) && body.error.trim() ? body.error.trim() : refusalMessage(response.status);
  return { kind: "refused", status: response.status, code, message };
}

/** One agent's stored runs, newest first, or null when they cannot be read. */
export async function readRuns(
  config: Config,
  workspaceId: string,
  agentId: string,
  paging: { before?: string; limit?: number } = {},
  options: AgentRequestOptions = {},
): Promise<AgentRunPage | null> {
  const doFetch = options.fetchImpl ?? fetch;
  const query = [paging.limit !== undefined ? `limit=${paging.limit}` : "", paging.before !== undefined ? `before=${encodeURIComponent(paging.before)}` : ""].filter(Boolean).join("&");
  try {
    const response = await doFetch(`${workspaceUrl(config, workspaceId)}/agents/${encodeURIComponent(agentId)}/runs${query ? `?${query}` : ""}`, {
      headers: headers(config),
      signal: options.signal,
    });
    if (!response.ok) return null;
    const body = asObject(await response.json());
    if (!Array.isArray(body.runs)) return null;
    return { runs: body.runs.filter(isRun), hasMore: body.hasMore === true };
  } catch {
    return null;
  }
}

/** Ticks or unticks one checklist item. Returns the saved item, or null when it could not be saved. */
export async function tickPlanItem(
  config: Config,
  workspaceId: string,
  itemId: string,
  done: boolean,
  options: AgentRequestOptions = {},
): Promise<PlanItem | null> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${workspaceUrl(config, workspaceId)}/plan-items/${encodeURIComponent(itemId)}`, {
      method: "PATCH",
      headers: headers(config),
      body: JSON.stringify({ done }),
      signal: options.signal,
    });
    if (!response.ok) return null;
    const { planItem } = asObject(await response.json());
    return isPlanItem(planItem) ? planItem : null;
  } catch {
    return null;
  }
}

// ---- helpers --------------------------------------------------------------------------------

/** True while any agent shows a run in progress. */
export const anyRunning = (entries: AgentEntry[]): boolean => entries.some((entry) => entry.running !== null);

/** How long to wait before asking again: POLL_MS while some agent is running, null (do not poll) when none is. */
export const nextPollMs = (entries: AgentEntry[]): number | null => (anyRunning(entries) ? POLL_MS : null);

/** One lowercase phrase for why a page was not read. */
export function reasonLabel(reason: AgentNotReadReason): string {
  switch (reason) {
    case "private_address":
      return "private or local address";
    case "not_secure":
      return "not a secure (https) page";
    case "needs_sign_in":
      return "needs sign-in";
    case "not_a_web_page":
      return "not a web page";
    case "too_large":
      return "too large";
    case "too_slow":
      return "too slow";
    case "no_text":
      return "no readable text";
    case "over_limit":
      return "over the page limit";
    default:
      return "could not be read";
  }
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What a result covers, in one plain line, so nobody takes a summary of three pages for a summary of
 * ten: "read 6 of 9 tabs; 3 not read: needs sign-in (2), too slow (1)". It also says when pages were
 * read at their plain address (query string and fragment removed) and when text was cut short.
 */
export function describeCoverage(sources: AgentSource[], coverage: AgentCoverage): string {
  const parts = [`read ${coverage.pagesRead} of ${count(coverage.tabsIncluded, "tab", "tabs")}`];

  const unread = sources.filter((source) => source.read !== "page");
  if (unread.length > 0) {
    const reasons = new Map<string, number>();
    for (const source of unread) {
      const label = source.reason ? reasonLabel(source.reason) : "not read";
      reasons.set(label, (reasons.get(label) ?? 0) + 1);
    }
    const listed = [...reasons].sort((a, b) => b[1] - a[1]).map(([label, n]) => `${label} (${n})`);
    parts.push(`${unread.length} not read: ${listed.join(", ")}`);
  }
  if (coverage.pagesRead === 0 && coverage.tabsIncluded > 0) parts.push("only titles, addresses, and excerpts were used");

  const trimmed = sources.filter((source) => source.read === "page" && source.trimmed).length;
  if (trimmed > 0) parts.push(`${count(trimmed, "page was", "pages were")} read at ${trimmed === 1 ? "its" : "their"} plain address (query and fragment removed)`);
  const cut = sources.filter((source) => source.read === "page" && source.truncated).length;
  if (cut > 0) parts.push(`${count(cut, "page was", "pages were")} cut short`);
  const leftOut = coverage.tabsTotal - coverage.tabsIncluded;
  if (leftOut > 0) parts.push(`${count(leftOut, "more tab was", "more tabs were")} left out (duplicates or over the limit)`);
  return parts.join("; ");
}

/** A new list with one item's `done` set. An id that is not in the list changes nothing. Applying it again with the old value is an exact revert. */
export function applyTick(items: PlanItem[], id: string, done: boolean): PlanItem[] {
  return items.map((item) => (item.id === id ? { ...item, done } : item));
}

/**
 * A result as plain lines, for a screen-reader label, a copy, and the read-only view of an older run.
 * Every string comes back exactly as the server sent it: nothing is escaped, stripped, or parsed.
 */
export function resultText(result: AgentResult): string[] {
  switch (result.kind) {
    case "text":
      return result.cited.length > 0 ? [result.text, `from: ${result.cited.map((tab) => tab.title).join(", ")}`] : [result.text];
    case "checklist":
      return [...result.items];
    case "quotes":
      return [...result.quotes.map((entry) => `“${entry.quote}” — ${entry.tab.title}`), ...(result.note ? [result.note] : [])];
    case "comparison":
      return [
        ...result.options.map((option) => `${option.name}: ${result.criteria.map((criterion, i) => `${criterion} = ${option.values[i] ?? ""}`).join("; ")}`),
        ...(result.verdict ? [result.verdict] : []),
      ];
  }
}

function plainOf(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url.split(/[?#]/)[0];
  }
}

/**
 * Whether a tab's saved address is the page a result shows. Results show the plain address (no query
 * string or fragment), cut to a fixed length, so a cut address matches by its start.
 */
export function matchesAddress(tabUrl: string, shown: string): boolean {
  const plain = plainOf(tabUrl);
  return shown.length >= SHOWN_ADDRESS_CHARS ? plain.startsWith(shown) : plain === plainOf(shown);
}

/** One plain line for how a run ended: "succeeded", the failure's own fixed sentence, or "running". */
export function describeRunOutcome(run: AgentRunView): string {
  if (run.state === "succeeded") return "succeeded";
  if (run.state === "running") return "running";
  return run.error?.message ?? "failed";
}

/** The runs to list under "earlier runs": everything except the result and the run the card already shows. Order is kept. */
export function olderRuns(entry: AgentEntry, runs: AgentRunView[]): AgentRunView[] {
  return runs.filter((run) => run.id !== entry.latest?.id && run.id !== entry.running?.id);
}
