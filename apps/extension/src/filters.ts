// What the extension is allowed to see. Only web pages (http/https) in normal
// windows are reportable; incognito windows and every other scheme (chrome://,
// chrome-extension://, about:, file:, view-source:, ...) are never read,
// queued, or sent (spec FR-013).

export const MAX_URL_LENGTH = 2048;

export function isEligibleUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export interface EligibilityCandidate {
  url?: string;
  incognito?: boolean;
}

/** The parts of chrome.tabs.Tab the extension reads. */
export interface TabLike extends EligibilityCandidate {
  id?: number;
  windowId: number;
  title?: string;
  active?: boolean;
  discarded?: boolean;
  status?: string;
}

export function isEligibleTab(tab: EligibilityCandidate): boolean {
  return tab.incognito !== true && isEligibleUrl(tab.url);
}

/** Truncates over-long URLs so they can still be reported instead of rejected. */
export function clampUrl(url: string): string {
  return url.length > MAX_URL_LENGTH ? url.slice(0, MAX_URL_LENGTH) : url;
}
