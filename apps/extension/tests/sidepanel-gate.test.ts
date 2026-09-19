import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHomeUrl, syncSidePanelForTab } from "../src/sidepanel-gate";

describe("side panel gate", () => {
  const setOptions = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    setOptions.mockClear();
    close.mockClear();
    vi.stubGlobal("chrome", {
      runtime: { id: "id", getURL: (path: string) => `chrome-extension://id/${path}` },
      sidePanel: { setOptions, close },
    });
  });

  it("recognizes the Home extension page", () => {
    expect(isHomeUrl("chrome-extension://id/home.html")).toBe(true);
    expect(isHomeUrl("chrome-extension://id/home.html#x")).toBe(true);
    expect(isHomeUrl("https://example.com")).toBe(false);
  });

  it("enables the panel on an eligible web page", async () => {
    await syncSidePanelForTab({ id: 3, url: "https://example.com/docs", incognito: false });
    expect(setOptions).toHaveBeenCalledWith({
      tabId: 3,
      path: "sidepanel.html",
      enabled: true,
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("disables and closes the panel on Home", async () => {
    await syncSidePanelForTab({
      id: 4,
      windowId: 9,
      url: "chrome-extension://id/home.html",
      incognito: false,
    });
    expect(setOptions).toHaveBeenCalledWith({ tabId: 4, enabled: false });
    expect(close).toHaveBeenCalledWith({ windowId: 9 });
  });

  it("disables and closes the panel on chrome pages", async () => {
    await syncSidePanelForTab({ id: 5, url: "chrome://newtab/", incognito: false });
    expect(setOptions).toHaveBeenCalledWith({ tabId: 5, enabled: false });
    expect(close).toHaveBeenCalledWith({ tabId: 5 });
  });

  it("does not disable when the tab URL is still unknown", async () => {
    await syncSidePanelForTab({ id: 6, url: undefined, incognito: false });
    expect(setOptions).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
