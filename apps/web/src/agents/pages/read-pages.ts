// Reads the pages of one run (specs/010-workspace-agents/contracts/model.md "Page reader seam").
// Which addresses get read is decided here and only here: each distinct plain address once, blocked
// ones never requested, at most `maxPages()` requested. Pages are read a few at a time, the whole
// step has a time budget, and a process-wide limit keeps many people's runs from opening too many
// downloads at once. It never throws and never logs; every failure is a reason.
import type { AgentNotReadReason } from "@ai-browser/shared";
import { maxPages, pageChars, PROCESS_READ_SLOTS, READ_CONCURRENCY, readBudgetMs, TOTAL_PAGE_CHARS } from "../limits";
import { cutText } from "./extract";
import { fetchPage, raceAbort, type PageResult } from "./fetch-page";
import { checkAddress } from "./safe-address";

export interface PageRequest {
  tabId: string;
  /** The tab's address; its query string and fragment are removed before anything is decided. */
  url: string;
}

export interface PageOutcome extends PageResult {
  tabId: string;
}

/** Reads one page. The signal aborts when the whole reading step runs out of time. */
export type PageFetcher = (url: string, signal: AbortSignal) => Promise<PageResult>;

let fetcherOverride: PageFetcher | null = null;
/** Tests only: every page read goes through this instead of the network (null restores the real reader). */
export function setPageFetcherForTests(fetcher: PageFetcher | null): void {
  fetcherOverride = fetcher;
}

const fail = (reason: AgentNotReadReason): PageResult => ({ text: null, reason, truncated: false });

/** The address without its query string and fragment: the identity of a page. */
function plainKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url.split(/[?#]/)[0];
  }
}

interface Entry {
  key: string;
  tabIds: string[];
  /** Set when the address is not one that may be requested. */
  refusal: AgentNotReadReason | null;
  /** Set when this page is past the per-run limit. */
  overLimit: boolean;
}

const willRead = (entry: Entry) => entry.refusal === null && !entry.overLimit;

/**
 * Decides, in order, what happens to each distinct address: refused (private, local, not https),
 * requested (the first `maxPages()` allowed ones), or over the limit. A refused address costs nothing
 * and does not use up a place, so a few private tabs never crowd out public ones.
 */
export function planReads(requests: PageRequest[]): Entry[] {
  const entries = new Map<string, Entry>();
  let requested = 0;
  for (const request of requests) {
    const key = plainKey(request.url);
    const known = entries.get(key);
    if (known) {
      known.tabIds.push(request.tabId);
      continue;
    }
    const checked = checkAddress(key);
    const refusal = checked.ok ? null : checked.reason;
    const overLimit = refusal === null && requested >= maxPages();
    if (refusal === null && !overLimit) requested += 1;
    entries.set(key, { key, tabIds: [request.tabId], refusal, overLimit });
  }
  return [...entries.values()];
}

/** How many pages a run over these addresses will actually request. */
export const countPagesToRead = (requests: PageRequest[]): number => planReads(requests).filter(willRead).length;

// ---- the process-wide limit on downloads at once -----------------------------------------------
interface Slots {
  free: number;
  waiters: (() => void)[];
}
type Holder = typeof globalThis & { __aiBrowserReadSlots?: Slots };
const slots = (): Slots => ((globalThis as Holder).__aiBrowserReadSlots ??= { free: PROCESS_READ_SLOTS, waiters: [] });

/** Tests only: forget every held slot. */
export function resetReadSlotsForTests(): void {
  delete (globalThis as Holder).__aiBrowserReadSlots;
}

/** A place among the process's downloads, or null when `signal` aborted while waiting. Call the result once to give it back. */
function acquireSlot(signal: AbortSignal): Promise<(() => void) | null> {
  const pool = slots();
  const release = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = pool.waiters.shift();
      if (waiter) waiter();
      else pool.free += 1;
    };
  };
  if (signal.aborted) return Promise.resolve(null);
  if (pool.free > 0) {
    pool.free -= 1;
    return Promise.resolve(release());
  }
  return new Promise((resolve) => {
    const grant = () => {
      signal.removeEventListener("abort", giveUp);
      resolve(release());
    };
    const giveUp = () => {
      const at = pool.waiters.indexOf(grant);
      if (at !== -1) pool.waiters.splice(at, 1);
      resolve(null);
    };
    pool.waiters.push(grant);
    signal.addEventListener("abort", giveUp, { once: true });
  });
}

// ---- reading ----------------------------------------------------------------------------------
async function readOne(fetcher: PageFetcher, url: string, budget: AbortSignal): Promise<PageResult> {
  const release = await acquireSlot(budget);
  if (release === null) return fail("too_slow");
  try {
    return await raceAbort(fetcher(url, budget), budget);
  } catch {
    return budget.aborted ? fail("too_slow") : fail("error");
  } finally {
    release();
  }
}

/** A fetcher's answer, made safe: a known shape, and never more text than one page may hold. */
function sanitize(result: PageResult | undefined): PageResult {
  if (!result || typeof result !== "object") return fail("error");
  if (typeof result.text !== "string") return fail(result.reason ?? "error");
  const cut = cutText(result.text, pageChars());
  return { text: cut.text, reason: null, truncated: result.truncated || cut.truncated };
}

/**
 * One outcome per request, in order. Tabs that share a plain address share one read. Pages past the
 * limit come back `over_limit`, refused addresses come back with their reason, and the total text
 * is bounded across the run.
 */
export async function readPages(requests: PageRequest[], options: { fetchPage?: PageFetcher } = {}): Promise<PageOutcome[]> {
  try {
    const fetcher: PageFetcher = options.fetchPage ?? fetcherOverride ?? ((url, signal) => fetchPage(url, { signal }));
    const entries = planReads(requests);
    const queue = entries.filter(willRead);
    const results = new Map<string, PageResult>();

    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), readBudgetMs());
    let next = 0;
    const worker = async () => {
      while (next < queue.length && !budget.signal.aborted) {
        const entry = queue[next++];
        results.set(entry.key, sanitize(await readOne(fetcher, entry.key, budget.signal)));
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, worker));
    } finally {
      clearTimeout(timer);
    }

    // Applied in request order, after every read finished, so the result never depends on which page was fastest.
    let remaining = TOTAL_PAGE_CHARS;
    const final = new Map<string, PageResult>();
    for (const entry of entries) {
      if (entry.refusal !== null) final.set(entry.key, fail(entry.refusal));
      else if (entry.overLimit) final.set(entry.key, fail("over_limit"));
      else {
        const result = results.get(entry.key) ?? fail("too_slow"); // never started: the budget ran out first
        if (result.text === null) final.set(entry.key, result);
        else if (remaining <= 0) final.set(entry.key, fail("over_limit"));
        else {
          const cut = cutText(result.text, remaining);
          remaining -= cut.text.length;
          final.set(entry.key, { text: cut.text, reason: null, truncated: result.truncated || cut.truncated });
        }
      }
    }
    return requests.map((request) => ({ tabId: request.tabId, ...(final.get(plainKey(request.url)) as PageResult) }));
  } catch {
    return requests.map((request) => ({ tabId: request.tabId, ...fail("error") }));
  }
}
