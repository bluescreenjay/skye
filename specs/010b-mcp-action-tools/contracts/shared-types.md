# Contract: Shared types for action tools

New file `packages/shared/src/actions.ts`, exported from `packages/shared/src/index.ts` (`export * from "./actions"`). The web app builds these; the Home card (and later the sidebar) import them from `@ai-browser/shared` and **must not redeclare them** (Constitution V). `ActionRun` and `PlanItem` in `domain.ts` are unchanged and are the stored shapes. IDs are UUID strings; times are UTC ISO-8601 strings. Tool ids are plain strings on the wire: the catalog is server-side and the client never enumerates it.

```ts
// packages/shared/src/actions.ts (feature 010b)

export type IntegrationId = "github" | "jira" | "notion" | "slack" | "drive" | "gmail";

/** A small badge on a suggested button. Never a list of anything else. */
export type ActionEffect = "local" | "browser" | "external" | "email";

// ---------- suggestions ----------

export interface SuggestionPreviewField { name: string; value: string }   // plain text, each value ≤ 200 chars

export interface ActionSuggestion {
  id: string;                                   // "s1"…"s6", valid for this set only
  toolId: string;
  label: string;                                // ≤ 60
  reason: string;                               // ≤ 140
  args: Record<string, unknown>;                // sent unchanged on click (locked)
  preview: SuggestionPreviewField[];
  effect: ActionEffect;
  service: IntegrationId | null;
}

/** POST /actions/suggest */
export interface SuggestionSet {
  status: "ok" | "failed";
  suggestions: ActionSuggestion[];              // 3 to 6 when ok and full; 0 when failed
  generatedAt: string;
  reused: boolean;                              // true when returned without a new AI request
  note: string | null;                          // fixed sentence: fewer than 3, or the failure
}

// ---------- runs ----------

export type ToolRunState = "running" | "succeeded" | "failed";

export interface ExternalLink { label: string; url: string | null; id: string | null }   // shown as text; opened only by an explicit click

export interface SearchItem { title: string; url: string | null; snippet: string }       // snippet ≤ 160

export type ToolResult =
  | { kind: "text"; text: string }                                                        // list tabs, read pages, share bundle
  | { kind: "copy"; text: string }                                                        // the card offers Copy
  | { kind: "summary"; text: string; coverage: { tabsTotal: number; tabsIncluded: number; pagesRead: number }; unreadable: number }
  | { kind: "file"; format: "md" | "pdf"; filename: string; bytes: number }               // a download intent was carried out
  | { kind: "opened"; opened: number; failed: number; skipped: { url: string; reason: OpenSkipReason }[]; placed: number | null }
  | { kind: "saved"; what: "queries" | "plan_items" | "refs"; added: number; skippedDuplicates: number; refused: number }
  | { kind: "created"; service: IntegrationId; what: string }                             // links are on the run output
  | { kind: "search"; service: IntegrationId; items: SearchItem[] }
  | { kind: "email_preview"; to: string | null; subject: string; body: string; expiresAt: string; state: EmailState }
  | { kind: "mail_search"; shown: number };                                               // the messages themselves are never stored

export type OpenSkipReason = "not_secure" | "private_address" | "not_a_web_page" | "over_limit" | "duplicate";
export type EmailState = "unsent" | "sending" | "sent" | "cancelled" | "expired";

export interface ToolStepNote { kind: "helper" | "action"; tool: string; note: string }   // fixed short notes only
export interface RefusedStep { tool: string; why: "not_allowed" | "unknown_tool" | "no_calls_left" }

export type BrowserIntent =
  | { id: string; kind: "open_tabs"; urls: string[]; placeInWorkspace: boolean; workspaceId: string }
  | { id: string; kind: "download"; format: "md" | "pdf"; filename: string };

export type ToolErrorCode =
  | "not_connected" | "rejected_credentials" | "service_error" | "bad_input" | "no_summary"
  | "step_limit" | "refused_only" | "budget_exhausted" | "model_error" | "bad_answer"
  | "browser_failed" | "timed_out";

export interface ToolRunView {
  id: string;
  toolId: string;
  state: ToolRunState;
  createdAt: string;
  label: string | null;                         // the button's text
  output: { result: ToolResult; links: ExternalLink[]; steps: ToolStepNote[]; refused: RefusedStep[]; stoppedAtLimit: boolean } | null;   // only when succeeded
  error: { code: ToolErrorCode; message: string; partial: string | null } | null;                                                              // only when failed
  /** Only while state is "running" and the run is waiting for the browser. */
  awaitingIntents: BrowserIntent[] | null;
}

/** GET /actions */
export interface WorkspaceActions {
  summary: { text: string; updatedAt: string; coverage: { tabsTotal: number; tabsIncluded: number; pagesRead: number }; unreadable: number } | null;
  queries: string[];
  refsCount: number;
  runs: ToolRunView[];                          // latest run per tool, newest first, ≤ 20
}

/** POST /actions/:toolId/run: 202 for a normal run, 200 for the mail search only. */
export interface RunStarted { run: ToolRunView }
export interface MailSearchDone { run: ToolRunView; mail: { messages: { from: string; subject: string; date: string; excerpt: string }[] } }

/** POST …/intents/:intentId */
export interface IntentReport { status: "done" | "failed"; opened?: number; failed?: number; placed?: number }

/** POST …/confirm */
export interface ConfirmSend { to: string }

// ---------- request errors ----------

export type ActionRequestErrorCode =
  | "not_a_workspace" | "unknown_tool" | "not_available" | "not_connected" | "invalid_body" | "bad_input"
  | "precondition" | "run_in_progress" | "too_many_runs" | "model_unconfigured"
  | "already_reported" | "already_sent" | "cancelled" | "expired" | "invalid_recipient" | "no_summary" | "invalid_format";
```

## Rules

- **`toolId` is a string**, not a union: the client must never need, or be able to derive, the whole catalog (FR-002). The server is the only place that knows every tool.
- **Mail**: `MailSearchDone.mail` exists only in the one response of a mail-search click. No other type carries a sender, subject, date, or excerpt of an email; `ToolResult` has none for stored runs.
- **No secrets in any type**: nothing here has a token, key, or credential field; `ToolRunView.output` and `error` are built from fixed sentences and the run's own result.
- The 010 types in `agents.ts` are unchanged. `AgentRunView` and `ToolRunView` are different shapes because their runs are different (five fixed agents versus a tool run with links, steps, and intents); both are rows of `action_runs`, told apart by `action_id`.
- Existing helpers that read runs (`mapActionRun` in `apps/web/src/map.ts`) gain a sibling `mapToolRun`; the agent mapper is unchanged.
