// Every fixed number of the action-tools feature, in one place
// (specs/010b-mcp-action-tools/research.md section 13). Env overrides are read at call time
// so tests can set them. An invalid, non-numeric, or out-of-range value falls back to the default.
function fromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Suggestions kept from a pass (shown 3 to 6 of these). */
export const SUGGEST_KEEP = 6;
export const SUGGEST_MIN = 3;
export const SUGGEST_DEADLINE_MS = 9_000;
export const SUGGEST_MAX_TOKENS = 1_500;
/** Reuse a stored suggestion set on open when the fingerprint is unchanged and it is this young. 0 = always a new pass. */
export const suggestReuseS = () => fromEnv("ACTIONS_SUGGEST_REUSE_S", 300, 0, 3_600);
/** Refresh (`force`) reuses only when unchanged and under this many seconds. */
export const SUGGEST_REFRESH_GAP_S = 30;

export const MAX_TURNS = 4;
export const MAX_HELPER_CALLS = 3;
export const TURN_DEADLINE_MS = 20_000;
export const TOOL_CALL_TIMEOUT_MS = 15_000;
/** Starting an MCP server and listing its tools (a cold `npx` can take a few seconds). */
export const CONNECT_TIMEOUT_MS = 20_000;
export const JOB_LIMIT_MS = 60_000;
export const STEP_MAX_TOKENS = 2_500;
export const HELPER_RESULT_CHARS = 6_000;

export const TABS_OPENED_MAX = 5;
export const SEARCHES_OPENED_MAX = 3;
export const SAVED_QUERIES_MAX = 10;
export const SAVED_REFS_MAX = 20;
export const SHARE_ADDRESSES_MAX = 5;
export const SHARE_BLURB_CHARS = 300;
export const MAIL_RESULTS_MAX = 5;
export const MAIL_EXCERPT_CHARS = 160;
export const CONFIRM_WINDOW_MS = 30 * 60 * 1_000;

export const TITLE_CHARS = 200;
export const MESSAGE_CHARS = 3_000;
export const BODY_CHARS = 8_000;
export const GIST_CHARS = 20_000;
export const QUERY_MIN = 3;
export const QUERY_MAX = 120;
export const LABEL_CHARS = 60;
export const REASON_CHARS = 140;
export const RUN_LABEL_CHARS = 80;
export const PREVIEW_VALUE_CHARS = 200;
export const SUMMARY_CHARS = 3_000;
export const SUMMARY_EXCERPT_CHARS = 1_200;
export const TAB_EXCERPT_CHARS = 200;
export const MAX_TABS_LISTED = 40;
export const COPY_TEXT_CHARS = 8_000;
export const PAGE_READ_MAX = 8;
export const PAGE_TEXT_CHARS = 4_000;
export const SAVE_QUERIES_PER_CLICK = 5;
export const PLAN_ITEMS_PER_CLICK = 8;
export const PLAN_ITEM_CHARS = 200;
export const REFS_PER_CLICK = 10;
export const QUOTE_MIN = 10;
export const QUOTE_MAX = 300;
export const SEARCH_ITEMS_MAX = 8;
export const SEARCH_SNIPPET_CHARS = 160;
export const FILENAME_CHARS = 80;

export const LATEST_RUNS_MAX = 20;
export const SUGGEST_SET_MAX_AGE_MS = () => suggestReuseS() * 1_000;
export const REJECTED_TTL_MS = 5 * 60 * 1_000;
export const BINDING_CACHE_MS = 5 * 60 * 1_000;
export const TOKEN_EXPIRY_SKEW_MS = 60_000;
export const MAIL_SEARCH_TIMEOUT_MS = 15_000;
export const INTENT_STALE_MESSAGE = "The browser did not respond. You can try again.";

// Google Calendar (owner only)
export const CALENDAR_RESULTS_MAX = 5;
export const CALENDAR_TITLE_CHARS = 120;
/** A look-up covers this many days from the chosen day. */
export const CALENDAR_WINDOW_DAYS = 7;
/** A start with no end lasts this long. */
export const EVENT_DEFAULT_MINUTES = 60;
export const EVENT_NOTES_CHARS = 2_000;
export const EVENT_LOCATION_CHARS = 200;
