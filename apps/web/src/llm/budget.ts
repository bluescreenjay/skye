// A guardrail on model requests per Pacific-time day, shared by every AI feature
// (specs/004-ai-clustering/research.md section 18). It exists because the free
// Gemini quota is small (about 500 requests a day) and one key is shared by the
// developer, a teammate, and demo viewers; one runaway loop would empty it.
//
// It counts attempts, not successes, and it is in memory: it resets when the server
// restarts, which errs toward allowing more calls. It is a guardrail, not a guarantee.
import { BudgetExceededError } from "./errors";

export type Purpose = "cluster" | "chat" | "plan" | "actions" | "command";

/** Each purpose's own share of a day. Beyond it, a purpose draws on the shared spill-over pool. */
export const SHARES: Record<Purpose, number> = {
  cluster: 50,
  chat: 170,
  plan: 40,
  actions: 80,
  command: 60,
};

/** Requests any purpose may make after its own share, up to the global cap. */
export const SPILL_OVER = 50;

export const DEFAULT_DAILY_CAP = 450;

// Google's daily quota resets at midnight Pacific time.
const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });

type State = { day: string; counts: Record<Purpose, number> };

// On globalThis so every copy of this module the bundler creates shares one counter.
const KEY = "__aiBrowserLlmBudget";
type Holder = typeof globalThis & { [KEY]?: State };

const emptyCounts = (): Record<Purpose, number> => ({ cluster: 0, chat: 0, plan: 0, actions: 0, command: 0 });

function state(now: Date): State {
  const holder = globalThis as Holder;
  const day = DAY_FORMAT.format(now);
  if (!holder[KEY] || holder[KEY]!.day !== day) holder[KEY] = { day, counts: emptyCounts() };
  return holder[KEY]!;
}

/** LLM_DAILY_CAP, or the default when it is unset or not a positive whole number. */
export function dailyCap(): number {
  const raw = process.env.LLM_DAILY_CAP;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAILY_CAP;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAILY_CAP;
}

/**
 * Reserves one request for `purpose`. Call it immediately BEFORE sending the request.
 * Throws BudgetExceededError when the global cap, or the purpose's share plus the
 * spill-over pool, is used up. Nothing is reserved when it throws.
 */
export function spend(purpose: Purpose, now: Date = new Date()): void {
  const s = state(now);
  const total = Object.values(s.counts).reduce((a, b) => a + b, 0);
  if (total >= dailyCap()) throw new BudgetExceededError();

  if (s.counts[purpose] >= SHARES[purpose]) {
    const spilled = (Object.keys(SHARES) as Purpose[]).reduce(
      (sum, p) => sum + Math.max(0, s.counts[p] - SHARES[p]),
      0,
    );
    if (spilled >= SPILL_OVER) throw new BudgetExceededError();
  }
  s.counts[purpose] += 1;
}

/** Requests counted so far today (Pacific time), for diagnostics. */
export function usage(now: Date = new Date()): { day: string; total: number; byPurpose: Record<Purpose, number> } {
  const s = state(now);
  return { day: s.day, total: Object.values(s.counts).reduce((a, b) => a + b, 0), byPurpose: { ...s.counts } };
}

/** Tests only. */
export function resetForTests(): void {
  delete (globalThis as Holder)[KEY];
}
