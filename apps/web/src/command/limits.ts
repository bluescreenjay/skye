// Every fixed number of the command bar, in one place (specs/011-global-command-bar/data-model.md,
// "Limits"). Nothing here reads the environment: these are product decisions, not tuning knobs.

/** Longest command, in characters after trimming. The client cuts at this visibly; the server refuses more. */
export const MAX_TEXT_CHARS = 300;

/** What the model is given (research 3). */
export const MAX_TABS_IN_PROMPT = 150;
export const MAX_WORKSPACES_IN_PROMPT = 40;
export const TITLE_CHARS = 100;
export const URL_CHARS = 100;
export const EXCERPT_CHARS = 100;

/** The one request. */
export const MODEL_DEADLINE_MS = 20_000;
export const MODEL_MAX_TOKENS = 900;

let abortOverride: number | null = null;
/** How long the pipeline waits for the model before it stops asking: the provider's own deadline plus a short grace. */
export const abortAfterMs = (): number => abortOverride ?? MODEL_DEADLINE_MS + 2_000;
/** Tests only: shorten the wait (null restores it). */
export function setAbortAfterMsForTests(ms: number | null): void {
  abortOverride = ms;
}

/** Below this the answer is a question, not an action (FR-010). */
export const CONFIDENCE_BAR = 0.6;

/** How long the single most recent change can be undone (FR-019). */
export const UNDO_WINDOW_MINUTES = 10;

/** One change never touches more tabs than this; the executor refuses more before writing. */
export const MAX_MOVES_PER_CHANGE = 200;
export const MAX_PREVIEW_LINES = 20;

/** Find. The model may rank a few more than are shown so the reply can say how many more there are. */
export const MAX_FOUND_TABS = 8;
export const MAX_FOUND_WORKSPACES = 5;
export const MODEL_FOUND_TABS = 12;

/** Tabs the model may list for group, move, or create (a described set; find has its own smaller list). */
export const MAX_DESCRIBED_TABS = 60;

/** Recall. */
export const MAX_RECALLED_WORKSPACES = 5;
export const MAX_RECALLED_TABS = 3;

/** Compound and unsure commands: the buttons that are offered. */
export const MAX_PARTS = 3;
export const PART_MAX_CHARS = 120;
export const MAX_ALTERNATIVES = 3;

/** Workspace matches the model may list for one phrase (best first). */
export const MAX_WORKSPACE_MATCHES = 3;

/** Request-shape caps (context). */
export const MAX_WINDOW_TAB_IDS = 500;
export const MAX_EXPANDED_IDS = 20;
