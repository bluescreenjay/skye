import { beforeEach, describe, expect, it } from "vitest";
import { closeDuplicateTabs, findDuplicateTabs } from "../src/home/close-duplicates";
import { installChromeMock, type ChromeMock, type MockTab } from "./helpers/chrome-mock";

let mock: ChromeMock;
beforeEach(() => {
  mock = installChromeMock();
});

const A = "https://example.com/a";
const B = "https://example.com/b";
let next = 1;
const tab = (over: Partial<MockTab> = {}): chrome.tabs.Tab =>
  ({ id: next++, windowId: 1, index: 0, url: A, title: "Page A", active: false, pinned: false, incognito: false, ...over }) as unknown as chrome.tabs.Tab;
const asMock = (tabs: chrome.tabs.Tab[]): MockTab[] => tabs as unknown as MockTab[];

describe("findDuplicateTabs: which copy stays", () => {
  it("keeps the active tab of the focused window", () => {
    const [first, active, third] = [tab({ index: 0 }), tab({ index: 1, active: true }), tab({ index: 2 })];
    const plan = findDuplicateTabs([first, active, third], 1);
    expect(plan.groups).toEqual([{ url: A, title: "Page A", keep: active.id, close: [first.id, third.id] }]);
    expect(plan.totalToClose).toBe(2);
  });

  it("an active tab in an unfocused window does not win when a focused one exists", () => {
    const inOther = tab({ windowId: 2, index: 0, active: true });
    const inFocused = tab({ windowId: 1, index: 0, active: true });
    expect(findDuplicateTabs([inOther, inFocused], 1).groups[0].keep).toBe(inFocused.id);
  });

  it("keeps the first pinned tab when none is active", () => {
    const [plain, pinned] = [tab({ index: 0 }), tab({ index: 3, pinned: true })];
    const plan = findDuplicateTabs([plain, pinned]);
    expect(plan.groups[0]).toMatchObject({ keep: pinned.id, close: [plain.id] });
  });

  it("otherwise keeps the lowest window id, then the lowest tab index", () => {
    const [w2i0, w1i5, w1i2] = [tab({ windowId: 2, index: 0 }), tab({ windowId: 1, index: 5 }), tab({ windowId: 1, index: 2 })];
    const plan = findDuplicateTabs([w2i0, w1i5, w1i2]);
    expect(plan.groups[0].keep).toBe(w1i2.id);
    expect(plan.groups[0].close.sort()).toEqual([w2i0.id, w1i5.id].sort());
  });

  it("never proposes closing a pinned tab, and drops a group with nothing left to close", () => {
    const [pinnedA, pinnedB, plain] = [tab({ pinned: true, index: 0 }), tab({ pinned: true, index: 1 }), tab({ index: 2 })];
    const plan = findDuplicateTabs([pinnedA, pinnedB, plain]);
    expect(plan.groups[0].close).toEqual([plain.id]);
    expect(findDuplicateTabs([tab({ pinned: true }), tab({ pinned: true })]).groups).toEqual([]);
  });
});

describe("findDuplicateTabs: what counts as a duplicate", () => {
  it("needs the whole address to be the same: fragments, queries, and paths are different pages", () => {
    const tabs = [tab({ url: `${A}#one` }), tab({ url: `${A}#two` }), tab({ url: `${A}?x=1` }), tab({ url: `${A}?x=2` }), tab({ url: A }), tab({ url: `${A}/` })];
    expect(findDuplicateTabs(tabs).groups).toEqual([]);
    expect(findDuplicateTabs([tab({ url: `${A}#one` }), tab({ url: `${A}#one` })]).totalToClose).toBe(1);
  });

  it("returns nothing for single tabs", () => {
    expect(findDuplicateTabs([tab({ url: A }), tab({ url: B })])).toEqual({ groups: [], totalToClose: 0 });
    expect(findDuplicateTabs([])).toEqual({ groups: [], totalToClose: 0 });
  });

  it("ignores incognito tabs and anything that is not a web page", () => {
    const tabs = [
      tab({ incognito: true }),
      tab({ incognito: true }),
      tab({ url: "chrome://extensions" }),
      tab({ url: "chrome://extensions" }),
      tab({ url: "chrome-extension://abc/home.html" }),
      tab({ url: "chrome-extension://abc/home.html" }),
      tab({ url: undefined as unknown as string }),
      tab({ url: undefined as unknown as string }),
    ];
    expect(findDuplicateTabs(tabs)).toEqual({ groups: [], totalToClose: 0 });
  });

  it("reports several groups, in a stable order, with the kept copy's title", () => {
    const plan = findDuplicateTabs([tab({ url: B, title: "Page B", index: 0 }), tab({ url: B, index: 1 }), tab({ url: A, title: "Page A", index: 2 }), tab({ url: A, index: 3 })]);
    expect(plan.groups.map((g) => [g.url, g.title])).toEqual([[A, "Page A"], [B, "Page B"]]);
    expect(plan.totalToClose).toBe(2);
  });
});

describe("closeDuplicateTabs", () => {
  const seed = (tabs: chrome.tabs.Tab[]) => {
    mock.tabs = asMock(tabs);
    return findDuplicateTabs(tabs, 1);
  };

  it("closes only the extras, with ONE remove call, and keeps one of each", async () => {
    const [keep, dup1, dup2] = [tab({ index: 0, active: true }), tab({ index: 1 }), tab({ index: 2 })];
    const plan = seed([keep, dup1, dup2]);
    expect(await closeDuplicateTabs(plan)).toEqual({ closed: 2, skipped: 0 });
    expect(mock.removedTabs).toEqual([[dup1.id, dup2.id]]);
    expect(mock.tabs.map((t) => t.id)).toEqual([keep.id]);
  });

  it("skips a tab that has navigated since the scan, and says so", async () => {
    const [keep, dup1, dup2] = [tab({ index: 0, active: true }), tab({ index: 1 }), tab({ index: 2 })];
    const plan = seed([keep, dup1, dup2]);
    (mock.tabs.find((t) => t.id === dup1.id) as MockTab).url = "https://elsewhere.example/";
    expect(await closeDuplicateTabs(plan)).toEqual({ closed: 1, skipped: 1 });
    expect(mock.removedTabs).toEqual([[dup2.id]]);
  });

  it("skips a tab that has since been pinned or gone incognito", async () => {
    const [keep, pinned, hidden] = [tab({ index: 0, active: true }), tab({ index: 1 }), tab({ index: 2 })];
    const plan = seed([keep, pinned, hidden]);
    (mock.tabs.find((t) => t.id === pinned.id) as MockTab).pinned = true;
    (mock.tabs.find((t) => t.id === hidden.id) as MockTab).incognito = true;
    expect(await closeDuplicateTabs(plan)).toEqual({ closed: 0, skipped: 2 });
    expect(mock.removedTabs).toEqual([]);
  });

  it("skips a tab that is already closed", async () => {
    const [keep, dup1, dup2] = [tab({ index: 0, active: true }), tab({ index: 1 }), tab({ index: 2 })];
    const plan = seed([keep, dup1, dup2]);
    mock.tabs = mock.tabs.filter((t) => t.id !== dup1.id);
    expect(await closeDuplicateTabs(plan)).toEqual({ closed: 1, skipped: 1 });
  });

  it("leaves a whole group alone when the copy meant to stay is gone (a page is never closed down to zero)", async () => {
    const [keep, dup] = [tab({ index: 0, active: true }), tab({ index: 1 })];
    const plan = seed([keep, dup]);
    mock.tabs = mock.tabs.filter((t) => t.id !== keep.id);
    expect(await closeDuplicateTabs(plan)).toEqual({ closed: 0, skipped: 1 });
    expect(mock.removedTabs).toEqual([]);
    expect(mock.tabs.map((t) => t.id)).toEqual([dup.id]);
  });

  it("does nothing for an empty plan and never throws when remove fails", async () => {
    expect(await closeDuplicateTabs({ groups: [], totalToClose: 0 })).toEqual({ closed: 0, skipped: 0 });
    const [keep, dup] = [tab({ index: 0, active: true }), tab({ index: 1 })];
    const plan = seed([keep, dup]);
    (chrome.tabs as unknown as { remove: () => Promise<void> }).remove = () => Promise.reject(new Error("no"));
    await expect(closeDuplicateTabs(plan)).resolves.toEqual({ closed: 0, skipped: 1 });
  });
});
