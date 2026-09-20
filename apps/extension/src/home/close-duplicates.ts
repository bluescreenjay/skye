// Finds and closes exact duplicate tabs for "clean up my browser" (feature 011: specs/011-global-command-bar/
// research.md 7, contracts/extension.md "Duplicate rules"). This is the extension's job, not the server's: the
// server keeps ONE record per address ("two tabs on the same page share one record"), so it cannot see a
// second open tab of a page. It lives under `home/` because the observe-only test allows `chrome.tabs.remove`
// only here and in `sidebar/`.
//
// Duplicates are tabs whose WHOLE address is the same string (a fragment counts: a single-page app's #/a and
// #/b are different pages). One copy stays in each group. Nothing is closed until the person confirms the list,
// and every tab is checked again right before it is closed.
import { isEligibleTab } from "../filters";
import type { DuplicatePlan } from "../ui/command";

/**
 * Groups eligible tabs (web pages, not incognito) by exact address and says which copy stays:
 *   1. the active tab of the focused window, if it is one of them;
 *   2. else the first pinned tab;
 *   3. else the lowest window id, then the lowest tab index.
 * A pinned tab is never a candidate to close. A group with nothing left to close is not returned.
 */
export function findDuplicateTabs(tabs: chrome.tabs.Tab[], focusedWindowId?: number): DuplicatePlan {
  const byAddress = new Map<string, chrome.tabs.Tab[]>();
  for (const tab of tabs) {
    if (typeof tab.id !== "number" || !tab.url || !isEligibleTab(tab)) continue;
    byAddress.set(tab.url, [...(byAddress.get(tab.url) ?? []), tab]);
  }
  const order = (a: chrome.tabs.Tab, b: chrome.tabs.Tab) => a.windowId - b.windowId || a.index - b.index;
  const groups: DuplicatePlan["groups"] = [];
  for (const [url, copies] of byAddress) {
    if (copies.length < 2) continue;
    const sorted = [...copies].sort(order);
    const keep =
      sorted.find((tab) => tab.active && (focusedWindowId === undefined || tab.windowId === focusedWindowId)) ?? sorted.find((tab) => tab.pinned) ?? sorted[0];
    const close = sorted.filter((tab) => tab !== keep && !tab.pinned).map((tab) => tab.id as number);
    if (close.length === 0) continue;
    groups.push({ url, title: keep.title ?? url, keep: keep.id as number, close });
  }
  groups.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return { groups, totalToClose: groups.reduce((sum, group) => sum + group.close.length, 0) };
}

/**
 * Closes the extra copies in a confirmed plan. Each tab is checked again first: it must still exist, not be
 * incognito or pinned, and still be on the address the person was shown; and the copy that was meant to stay must
 * still be there, or the whole group is left alone (so a page is never closed down to zero copies). Anything
 * skipped is counted. One `tabs.remove` call closes the ones that passed.
 */
export async function closeDuplicateTabs(plan: DuplicatePlan): Promise<{ closed: number; skipped: number }> {
  const toClose: number[] = [];
  let skipped = 0;
  for (const group of plan.groups) {
    let keptStillThere = false;
    try {
      const kept = await chrome.tabs.get(group.keep);
      keptStillThere = kept.url === group.url && !kept.incognito;
    } catch {
      keptStillThere = false;
    }
    if (!keptStillThere) {
      skipped += group.close.length;
      continue;
    }
    for (const id of group.close) {
      try {
        const tab = await chrome.tabs.get(id);
        if (tab.incognito || tab.pinned || tab.url !== group.url) skipped += 1;
        else toClose.push(id);
      } catch {
        skipped += 1; // already gone: nothing to close
      }
    }
  }
  if (toClose.length === 0) return { closed: 0, skipped };
  try {
    await chrome.tabs.remove(toClose);
  } catch {
    return { closed: 0, skipped: skipped + toClose.length };
  }
  return { closed: toClose.length, skipped };
}
