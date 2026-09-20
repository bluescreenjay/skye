// Types for the global command bar (feature 011). The web app builds these; the bar (Home and the
// sidebar) imports them from `@ai-browser/shared` and must not redeclare them.
// Contract: specs/011-global-command-bar/contracts/shared-command-types.md
// IDs are UUID strings; times are UTC ISO-8601 strings. Every string in a reply is plain text.
import type { AgentId } from "./agents";
import type { TabRef, Workspace } from "./domain";

/** The fixed intent set (spec FR-005). Not extensible by the model. */
export const COMMAND_INTENTS = [
  "organize",
  "cleanup",
  "group",
  "move",
  "rename",
  "merge",
  "create",
  "show",
  "open_workspace",
  "find",
  "recall",
  "undo",
  "agent",
] as const;
export type CommandIntent = (typeof COMMAND_INTENTS)[number];

/** The example commands the bar shows when it opens, and the `help` list of a refusal. */
export const COMMAND_EXAMPLES = [
  "organize my tabs",
  "create a workspace for these tabs",
  "put my shopping tabs together",
  "clean up my browser",
  "what was I working on yesterday?",
  "summarize this workspace",
] as const;

/** Where the person is when they open the bar. */
export interface CommandContext {
  surface: "home" | "page";
  /** IANA time zone, e.g. "America/New_York". Used only to read "yesterday" and "last week". */
  timeZone: string;
  /** Home: ids of the expanded cards (Home has at most one). Otherwise []. */
  expandedWorkspaceIds: string[];
  /** A page: the active tab. Otherwise null. */
  activeTab: { chromeTabId: number; url: string } | null;
  /** A page: Chrome tab ids open in this window. Otherwise []. */
  windowTabIds: number[];
}

/** POST /api/command request. */
export interface CommandRequest {
  text: string; // 1 to 300 characters after trimming
  context: CommandContext;
}

export type NavTarget = { kind: "home" } | { kind: "workspace"; workspaceId: string };

/** A resolved, executable step. Ids are real and are re-validated by the server on apply. */
export type CommandAction =
  | { type: "organize" }
  | { type: "cleanup" }
  | { type: "group"; tabRefIds: string[]; target: { workspaceId: string } | { newName: string } }
  | { type: "move"; tabRefIds: string[]; toWorkspaceId: string | null } // null = Other
  | { type: "rename"; workspaceId: string; name: string }
  | { type: "merge"; fromWorkspaceId: string; intoWorkspaceId: string }
  | { type: "create"; name: string; tabRefIds: string[] }
  | { type: "agent"; workspaceId: string; agentId: AgentId }
  | { type: "undo" };

/**
 * One button of a question. `action` and `navigate` are resolved and run with no further AI
 * request; `submit` sends a fixed or verbatim phrase as a new command.
 */
export interface CommandChoice {
  label: string;
  step:
    | { kind: "action"; action: CommandAction }
    | { kind: "navigate"; target: NavTarget }
    | { kind: "submit"; text: string };
}

export interface FoundTab {
  tab: TabRef;
  workspaceName: string; // "Other" when tab.workspaceId is null
}
export interface FoundWorkspace {
  workspace: Workspace;
  tabCount: number;
}

export interface RecalledTab {
  title: string;
  url: string;
  visits: number;
}
export interface RecalledWorkspace {
  workspaceId: string | null; // null = Other
  name: string;
  linkable: boolean; // false for Other and for an archived workspace
  visits: number;
  tabs: RecalledTab[]; // at most 3
}

/** POST /api/command response (200). Every string is plain text; render it as text, never as HTML. */
export type CommandReply =
  /** Something to do. `understood` is shown as it starts (FR-009). Agent actions are run by the client through the 010 routes; every other action goes to /apply. */
  | { kind: "action"; understood: string; action: CommandAction }
  /** Change only what is on screen. */
  | { kind: "navigate"; understood: string; target: NavTarget }
  | { kind: "found"; understood: string; tabs: FoundTab[]; workspaces: FoundWorkspace[]; more: number; cutNote: string | null }
  | { kind: "recalled"; understood: string; periodLabel: string; workspaces: RecalledWorkspace[] }
  /** A plain message and nothing else happened: a refusal, "no match", "nothing to do", or a doubt. `help` is the short list of what the bar can do, when it applies. */
  | { kind: "say"; message: string; help: string[] | null }
  /** Which one? Nothing has run. */
  | { kind: "ask"; question: string; choices: CommandChoice[] };

export interface UndoState {
  kind: "organize" | "group" | "move" | "rename" | "merge" | "create";
  summary: string; // e.g. "moved 3 tabs into Kyoto trip"
  expiresAt: string;
}

export interface ChangePreview {
  title: string;
  lines: { tabRefId: string | null; title: string; from: string; to: string }[]; // at most 20
  hiddenCount: number;
}

/** What a change did, in counts the client can show. Counts that do not apply are 0. */
export interface ChangeCounts {
  moved: number;
  alreadyThere: number;
  missing: number;
  workspacesCreated: number;
  suggestions: number; // organize: groups left as suggestions
  leftOut: number; // organize: loose tabs past the run limit
}

/** POST /api/command/apply response (200). */
export type CommandApplyResult =
  | { status: "needs_confirmation"; preview: ChangePreview }
  | {
      status: "done";
      message: string; // plain, e.g. "Moved 9 tabs into 3 workspaces. 2 left as suggestions."
      counts: ChangeCounts;
      undo: UndoState | null; // the state after this call
      /** cleanup: the organize step is done; the client now scans for duplicates itself. */
      next: "scan_duplicates" | null;
      /** A workspace the person can be taken to (the one created, or renamed). */
      workspace: { id: string; name: string } | null;
    }
  | { status: "nothing_to_do"; message: string; undo: UndoState | null }
  | { status: "refused"; code: CommandRefusalCode; message: string };

/** Refusals the bar can act on. Fixed sentences; never text from the AI service. */
export type CommandRefusalCode =
  | "not_found" // a workspace or tabs no longer exist
  | "name_taken"
  | "reserved_name"
  | "same_workspace" // merge into itself
  | "too_many" // over MAX_MOVES_PER_CHANGE
  | "run_in_progress" // organize already running
  | "budget_exhausted"
  | "model_error"
  | "model_unconfigured";

export type CommandRequestErrorCode =
  | "text_empty"
  | "text_too_long"
  | "bad_context"
  | "bad_time_zone"
  | "bad_action"
  | "confirmation_required"
  | "model_unconfigured"
  | "budget_exhausted"
  | "model_error"
  | "busy"; // the AI service asked us to wait and the deadline passed
