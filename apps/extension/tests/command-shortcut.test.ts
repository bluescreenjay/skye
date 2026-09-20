import { beforeEach, describe, expect, it, vi } from "vitest";
import { installCommandShortcut, OPEN_COMMAND } from "../src/command-shortcut";
import { SIGNAL_KEY, type CommandSignal } from "../src/ui/command-signal";
import { installChromeMock, type ChromeMock } from "./helpers/chrome-mock";

let mock: ChromeMock;
const openHome = vi.fn(async () => undefined);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const signal = () => mock.session.get(SIGNAL_KEY) as CommandSignal | undefined;

beforeEach(() => {
  mock = installChromeMock();
  openHome.mockClear();
  installCommandShortcut({ openHome });
});

const page = { id: 7, windowId: 1, url: "https://example.com/a", active: true };

describe("the command bar shortcut", () => {
  it("opens the Side Panel for a web page BEFORE any awaited call, then asks the bar to open", async () => {
    mock.fireCommand(OPEN_COMMAND, page);
    // Synchronously, before anything could have been awaited: the panel open call is the first and only call so far.
    expect(mock.calls[0]).toBe("sidePanel.open");
    expect(mock.calls.filter((call) => call !== "sidePanel.open" && call !== "storage.session.set")).toEqual([]);
    expect(mock.sidePanelOpens).toEqual([{ tabId: 7 }]);
    await flush();
    expect(signal()).toMatchObject({ kind: "open", tabId: 7 });
    expect(openHome).not.toHaveBeenCalled();
  });

  it("never queries tabs to decide: it uses the tab it was given (a query would spend the user gesture)", async () => {
    mock.fireCommand(OPEN_COMMAND, page);
    await flush();
    expect(mock.calls).not.toContain("tabs.query");
    expect(mock.calls).not.toContain("tabs.get");
  });

  it("only signals for Home, and does not open the panel", async () => {
    mock.fireCommand(OPEN_COMMAND, { id: 3, windowId: 1, url: "chrome-extension://test-extension-id/home.html" });
    await flush();
    expect(mock.sidePanelOpens).toEqual([]);
    expect(signal()).toMatchObject({ kind: "open", tabId: 3 });
    expect(openHome).not.toHaveBeenCalled();
  });

  it.each([
    ["a browser page", { id: 4, windowId: 1, url: "chrome://extensions" }],
    ["a blank tab", { id: 5, windowId: 1, url: "about:blank" }],
    ["an incognito tab", { id: 6, windowId: 1, url: "https://example.com/", incognito: true }],
    ["another extension's page", { id: 8, windowId: 1, url: "chrome-extension://other/page.html" }],
    ["no tab at all", undefined],
    ["a tab with no id", { windowId: 1, url: "https://example.com/" }],
  ])("opens Home with the bar for %s, and never opens the panel", async (_name, tab) => {
    mock.fireCommand(OPEN_COMMAND, tab);
    await flush();
    expect(mock.sidePanelOpens).toEqual([]);
    expect(openHome).toHaveBeenCalledTimes(1);
    expect(signal()).toMatchObject({ kind: "open", tabId: "new" });
  });

  it("falls back to Home when Chrome refuses to open the panel", async () => {
    mock.sidePanelRejects = true;
    mock.fireCommand(OPEN_COMMAND, page);
    await flush();
    await flush();
    expect(mock.sidePanelOpens).toEqual([{ tabId: 7 }]);
    expect(openHome).toHaveBeenCalledTimes(1);
    expect(signal()).toMatchObject({ kind: "open", tabId: "new" });
  });

  it("does nothing for another command", async () => {
    mock.fireCommand("something-else", page);
    await flush();
    expect(mock.calls).toEqual([]);
    expect(openHome).not.toHaveBeenCalled();
    expect(signal()).toBeUndefined();
  });

  it("never throws out of the listener, even when opening Home fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installCommandShortcut({ openHome: async () => { throw new Error("no window"); } });
    expect(() => mock.fireCommand(OPEN_COMMAND, undefined)).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
