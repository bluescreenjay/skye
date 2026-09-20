// Response shapes for action tools (feature 010b). The web app builds these; the Home card
// (and later the sidebar) import them from `@ai-browser/shared` and must not redeclare them.
// Contract: specs/010b-mcp-action-tools/contracts/shared-types.md
// `ActionRun` and `PlanItem` in domain.ts are unchanged. IDs are UUID strings; times are UTC ISO-8601 strings.
// Tool ids are plain strings on the wire: the catalog is server-side and the client never enumerates it.

export type IntegrationId = "github" | "jira" | "notion" | "slack" | "drive" | "gmail" | "calendar";

/** A small badge on a suggested button. Never a list of anything else. */
export type ActionEffect = "local" | "browser" | "external" | "email";

export interface SuggestionPreviewField {
  name: string;
  value: string;
}

export interface ActionSuggestion {
  id: string;
  toolId: string;
  label: string;
  reason: string;
  args: Record<string, unknown>;
  preview: SuggestionPreviewField[];
  effect: ActionEffect;
  service: IntegrationId | null;
}

/** POST /actions/suggest */
export interface SuggestionSet {
  status: "ok" | "failed";
  suggestions: ActionSuggestion[];
  generatedAt: string;
  reused: boolean;
  note: string | null;
}

export type ToolRunState = "running" | "succeeded" | "failed";

export interface ExternalLink {
  label: string;
  url: string | null;
  id: string | null;
}

export interface SearchItem {
  title: string;
  url: string | null;
  snippet: string;
}

export type ToolResult =
  | { kind: "text"; text: string }
  | { kind: "copy"; text: string }
  | { kind: "summary"; text: string; coverage: { tabsTotal: number; tabsIncluded: number; pagesRead: number }; unreadable: number }
  | { kind: "file"; format: "md" | "pdf"; filename: string; bytes: number }
  | { kind: "opened"; opened: number; failed: number; skipped: { url: string; reason: OpenSkipReason }[]; placed: number | null }
  | { kind: "saved"; what: "queries" | "plan_items" | "refs"; added: number; skippedDuplicates: number; refused: number }
  | { kind: "created"; service: IntegrationId; what: string }
  | { kind: "search"; service: IntegrationId; items: SearchItem[] }
  | { kind: "email_preview"; to: string | null; subject: string; body: string; expiresAt: string; state: EmailState }
  | { kind: "mail_search"; shown: number }
  | { kind: "calendar_events"; shown: number }; // the events themselves are never stored

export type OpenSkipReason = "not_secure" | "private_address" | "not_a_web_page" | "over_limit" | "duplicate";
export type EmailState = "unsent" | "sending" | "sent" | "cancelled" | "expired";

export interface ToolStepNote {
  kind: "helper" | "action";
  tool: string;
  note: string;
}

export interface RefusedStep {
  tool: string;
  why: "not_allowed" | "unknown_tool" | "no_calls_left";
}

export type BrowserIntent =
  | { id: string; kind: "open_tabs"; urls: string[]; placeInWorkspace: boolean; workspaceId: string }
  | { id: string; kind: "download"; format: "md" | "pdf"; filename: string };

export type ToolErrorCode =
  | "not_connected"
  | "rejected_credentials"
  | "service_error"
  | "bad_input"
  | "no_summary"
  | "step_limit"
  | "refused_only"
  | "budget_exhausted"
  | "model_error"
  | "bad_answer"
  | "browser_failed"
  | "timed_out";

export interface ToolRunView {
  id: string;
  toolId: string;
  state: ToolRunState;
  createdAt: string;
  label: string | null;
  output: {
    result: ToolResult;
    links: ExternalLink[];
    steps: ToolStepNote[];
    refused: RefusedStep[];
    stoppedAtLimit: boolean;
  } | null;
  error: { code: ToolErrorCode; message: string; partial: string | null } | null;
  awaitingIntents: BrowserIntent[] | null;
}

/** GET /actions */
export interface WorkspaceActions {
  summary: {
    text: string;
    updatedAt: string;
    coverage: { tabsTotal: number; tabsIncluded: number; pagesRead: number };
    unreadable: number;
  } | null;
  queries: string[];
  refsCount: number;
  runs: ToolRunView[];
}

/** POST /actions/:toolId/run: 202 for a normal run, 200 for the mail search only. */
export interface RunStarted {
  run: ToolRunView;
}

export interface MailSearchDone {
  run: ToolRunView;
  mail: { messages: { from: string; subject: string; date: string; excerpt: string }[] };
}

/** The calendar look-up (200): the events exist only in this response. Never stored, never given to the AI. */
export interface CalendarListDone {
  run: ToolRunView;
  calendar: { events: { title: string; start: string; end: string; allDay: boolean }[] };
}

/** POST …/intents/:intentId */
export interface IntentReport {
  status: "done" | "failed";
  opened?: number;
  failed?: number;
  placed?: number;
}

/** POST …/confirm */
export interface ConfirmSend {
  to: string;
}

export type ActionRequestErrorCode =
  | "not_a_workspace"
  | "unknown_tool"
  | "not_available"
  | "not_connected"
  | "invalid_body"
  | "bad_input"
  | "precondition"
  | "run_in_progress"
  | "too_many_runs"
  | "model_unconfigured"
  | "already_reported"
  | "already_sent"
  | "cancelled"
  | "expired"
  | "invalid_recipient"
  | "no_summary"
  | "invalid_format";
