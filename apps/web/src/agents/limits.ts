// Every fixed number of the agents feature, in one place (specs/010-workspace-agents/research.md
// sections 2, 6, and 9). The five that reading pages needs can be overridden by environment
// variables; they are read at call time so tests can set them. An invalid, non-numeric, or
// out-of-range value falls back to the default.

function fromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Most pages read for one run. */
export const maxPages = () => fromEnv("AGENT_MAX_PAGES", 8, 0, 20);
/** Most time one page may take. */
export const pageTimeoutMs = () => fromEnv("AGENT_PAGE_TIMEOUT_MS", 8_000, 100, 60_000);
/** Most time the whole reading step may take. */
export const readBudgetMs = () => fromEnv("AGENT_READ_BUDGET_MS", 12_000, 100, 120_000);
/** Most bytes read from one page, after decompression. */
export const pageBytes = () => fromEnv("AGENT_PAGE_BYTES", 500_000, 1_000, 5_000_000);
/** Most characters of text kept from one page. */
export const pageChars = () => fromEnv("AGENT_PAGE_CHARS", 4_000, 200, 20_000);

export const MAX_REDIRECTS = 2;
export const TOTAL_PAGE_CHARS = 30_000;
/** Pages read at the same time within one run. */
export const READ_CONCURRENCY = 4;
/** Page downloads at the same time across the whole server process. */
export const PROCESS_READ_SLOTS = 8;

/** Runs one person may have going at once. */
export const MAX_RUNNING_PER_USER = 5;
/** Runs kept per agent per workspace. */
export const KEEP_RUNS = 10;
/** A run still `pending` after this long is treated as crashed. */
export const STALE_RUN_SECONDS = 120;
/** The whole job (reading, asking, saving) may take at most this long. */
export const JOB_LIMIT_MS = 50_000;
/** The AI call's own deadline (its default is 25 s; agents read more, so they get 30 s). */
export const MODEL_DEADLINE_MS = 30_000;
export const MODEL_MAX_TOKENS = 3_000;

/** What the model is given about the tabs. */
export const MAX_TABS_LISTED = 40;
export const TAB_TITLE_CHARS = 200;
export const TAB_URL_CHARS = 200;
export const TAB_EXCERPT_CHARS = 400;

export const MAX_PLAN_ITEMS = 30;
export const CHECKLIST_MAX_ITEMS = 8;
export const CHECKLIST_ITEM_CHARS = 200;
