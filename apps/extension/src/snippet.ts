// Short page excerpts (spec FR-004, FR-005). A snippet is a few sentences of
// plain text read from the page, never markup, and never a reason to drop a
// tab: if the page cannot be read the snippet is simply empty.
import { SNIPPET_MAX_LENGTH } from "@ai-browser/shared";
import type { TabLike } from "./filters";
import type { SnippetCacheEntry, Store } from "./store";

/** How many pages a full snapshot reads at once, so 100 tabs finish quickly without a burst of work. */
export const SNIPPET_CONCURRENCY = 5;

/**
 * Runs inside the page (Chrome serialises it), so it must not use anything from
 * this module. It returns more than a snippet needs so that whitespace
 * collapsing can still fill the limit, but stops huge pages from being shipped whole.
 */
export function readPageText(): string {
  return (document.body?.innerText ?? "").slice(0, 8000);
}

/** Collapses whitespace and cuts to the limit. Anything that is not text becomes an empty snippet. */
export function normalizeSnippet(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX_LENGTH).trimEnd();
}

/** Reads a tab's text. Restricted pages, closed tabs, and PDFs give an empty snippet, not an error. */
export async function captureSnippet(tabId: number): Promise<string> {
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: readPageText });
    return normalizeSnippet(injection?.result);
  } catch {
    return "";
  }
}

export interface SnippetDeps {
  store: Store;
  capture: (tabId: number) => Promise<string>;
}

export interface ResolvedSnippet {
  text: string;
  /** Set when the page was read; the caller stores it so the next change can reuse it. */
  cache?: SnippetCacheEntry;
}

/**
 * Decides whether to read the page or reuse the last snippet:
 *  - read when the address changed, nothing is cached, or the last read found no text;
 *  - never read a page that is still loading or a discarded tab;
 *  - a snippet is only reused for the address it was read from.
 */
export async function resolveSnippet(
  deps: SnippetDeps,
  tab: TabLike,
  tabId: number,
  url: string,
): Promise<ResolvedSnippet> {
  const cached = await deps.store.getSnippet(tabId);
  const sameAddress = cached !== undefined && cached.url === url;
  const canRead = !tab.discarded && (tab.status === undefined || tab.status === "complete");

  if (canRead && (!sameAddress || cached.text === "")) {
    let text = "";
    try {
      text = normalizeSnippet(await deps.capture(tabId));
    } catch {
      // A failed read is an empty snippet; the tab is still reported.
    }
    return { text, cache: { url, text } };
  }
  return { text: sameAddress ? cached.text : "" };
}

/** Like Promise.all over a mapped list, but never more than `limit` calls at once. Results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
