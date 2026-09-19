# Contract: Shared agent types

Response shapes for workspace agents (feature 010). The web app builds these; the Home card (this feature) and the sidebar (feature 006) import them from `@ai-browser/shared` and must not redeclare them. They go in `packages/shared/src/agents.ts` and are exported from `packages/shared/src/index.ts`. `PlanItem` is unchanged and lives in `domain.ts`. IDs are UUID strings; times are UTC ISO-8601 strings.

```ts
import type { PlanItem } from "./domain";

export type AgentId = "summarize" | "compare" | "missing" | "next-steps" | "refs";
export type AgentKind = "text" | "comparison" | "checklist" | "quotes";

/** One entry of the fixed catalog. Not stored. */
export interface AgentDescriptor {
  id: AgentId;
  name: string;
  description: string;
  kind: AgentKind;
}

export type AgentRunState = "running" | "succeeded" | "failed";

/** Why a tab's page text was not used. */
export type AgentNotReadReason =
  | "private_address" | "not_secure" | "needs_sign_in" | "not_a_web_page"
  | "too_large" | "too_slow" | "no_text" | "error" | "over_limit";

export type AgentErrorCode = "budget_exhausted" | "model_error" | "bad_answer" | "timed_out";

/** Codes on refused requests (HTTP errors), in addition to the run-level AgentErrorCode. */
export type AgentRequestErrorCode =
  | "not_a_workspace" | "unknown_agent" | "run_in_progress" | "no_tabs"
  | "too_many_runs" | "model_unconfigured" | "invalid_cursor" | "invalid_body";

/** A tab, by title and plain address (no query string or fragment). */
export interface AgentTabRef { title: string; url: string; }

export interface AgentSource extends AgentTabRef {
  /** "page" when page text was read; "excerpt" when only the stored excerpt, title, and address were known. */
  read: "page" | "excerpt";
  reason: AgentNotReadReason | null;
  /** The tab's address had a query string or fragment that was removed to read the page. */
  trimmed: boolean;
  /** The page text was cut at the size limit. */
  truncated: boolean;
}

export interface AgentCoverage { tabsTotal: number; tabsIncluded: number; pagesRead: number; }

export type AgentResult =
  | { kind: "text"; text: string; cited: AgentTabRef[] }
  | { kind: "comparison"; criteria: string[]; options: { name: string; tab: AgentTabRef | null; values: string[] }[]; verdict: string }
  | { kind: "checklist"; items: string[] }
  | { kind: "quotes"; quotes: { quote: string; tab: AgentTabRef }[]; note: string | null };

/** Counts only. Never tab text, page text, or addresses. */
export interface AgentRunInput { tabsTotal: number; tabsIncluded: number; pagesTried: number; chatMessages: number; planItems: number; }

export interface AgentRunView {
  id: string;
  agentId: AgentId;
  state: AgentRunState;
  createdAt: string;
  input: AgentRunInput;
  /** Set only when state is "succeeded". */
  output: { result: AgentResult; sources: AgentSource[]; coverage: AgentCoverage } | null;
  /** Set only when state is "failed". A fixed sentence, never text from the AI service. */
  error: { code: AgentErrorCode; message: string } | null;
}

/** GET /api/workspaces/:id/agents */
export interface AgentEntry extends AgentDescriptor {
  /** The latest finished run. */
  latest: AgentRunView | null;
  /** The run in progress, if any. */
  running: AgentRunView | null;
  /** The latest failed run, only when it is newer than `latest`. */
  lastFailed: AgentRunView | null;
}
export interface WorkspaceAgents { agents: AgentEntry[]; planItems: PlanItem[]; }

/** GET /api/workspaces/:id/agents/:agentId/runs */
export interface AgentRunPage { runs: AgentRunView[]; hasMore: boolean; }
```

Notes:

- `AgentRunView.state` maps the stored status: `pending` is `running`.
- `AgentRunView` is what the server builds from an `action_runs` row (`mapActionRun`); the stored `output` is `{ result, sources, coverage }` or `{ error }`, so the view's `output` and `error` are read straight from it.
- The client must treat every string in a result as text, never markup (http.md, rule 1).
