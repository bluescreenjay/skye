import type { TabRef } from "@ai-browser/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeHomeTab, openHomeTab } from "../src/home/navigation";

const savedTab = (overrides: Partial<TabRef> = {}): TabRef => ({
  id: "tab-ref-1",
  userId: "user-1",
  chromeTabId: 42,
  url: "https://example.com/work",
  title: "Work",
  workspaceId: "workspace-1",
  snippet: "",
  lastSeenAt: "2026-09-19T12:00:00.000Z",
  placementSource: null,
  ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

describe("Home saved-tab navigation", () => {
  it("focuses a matching live tab and opens Skye in its Side Panel", async () => {
    const get = vi.fn().mockResolvedValue({ id: 42, url: "https://example.com/work", windowId: 7, incognito: false });
    const updateWindow = vi.fn().mockResolvedValue(undefined);
    const updateTab = vi.fn().mockResolvedValue(undefined);
    const openPanel = vi.fn().mockResolvedValue(undefined);
    const setOptions = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: { id: "id", getURL: (path: string) => `chrome-extension://id/${path}` },
      tabs: { get, update: updateTab, create },
      windows: { update: updateWindow },
      sidePanel: { open: openPanel, setOptions, close: vi.fn() },
    });

    await openHomeTab(savedTab());

    expect(updateWindow).toHaveBeenCalledWith(7, { focused: true });
    expect(updateTab).toHaveBeenCalledWith(42, { active: true });
    expect(setOptions).toHaveBeenCalledWith({
      tabId: 42,
      path: "sidepanel.html",
      enabled: true,
    });
    expect(openPanel).toHaveBeenCalledWith({ tabId: 42 });
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps the focused tab when Side Panel open fails", async () => {
    const get = vi.fn().mockResolvedValue({ id: 42, url: "https://example.com/work", windowId: 7, incognito: false });
    const create = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: { id: "id", getURL: (path: string) => `chrome-extension://id/${path}` },
      tabs: { get, update: vi.fn().mockResolvedValue(undefined), create },
      windows: { update: vi.fn().mockResolvedValue(undefined) },
      sidePanel: {
        open: vi.fn().mockRejectedValue(new Error("disabled")),
        setOptions: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      },
    });

    await openHomeTab(savedTab());

    expect(create).not.toHaveBeenCalled();
  });

  it("opens a new tab only when the saved browser tab is no longer live", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", { tabs: { get: vi.fn().mockRejectedValue(new Error("closed")), create } });

    await openHomeTab(savedTab());

    expect(create).toHaveBeenCalledWith({ url: "https://example.com/work" });
  });

  it("focusOrOpenSavedTab reuses a live tab without opening the panel", async () => {
    const { focusOrOpenSavedTab } = await import("../src/home/navigation");
    const get = vi.fn().mockResolvedValue({ id: 42, url: "https://example.com/work", windowId: 7, incognito: false });
    const updateTab = vi.fn().mockResolvedValue(undefined);
    const openPanel = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { get, update: updateTab, create: vi.fn() },
      windows: { update: vi.fn().mockResolvedValue(undefined) },
      sidePanel: { open: openPanel },
    });

    await expect(focusOrOpenSavedTab(savedTab())).resolves.toBe("focused");
    expect(updateTab).toHaveBeenCalledWith(42, { active: true });
    expect(openPanel).not.toHaveBeenCalled();
  });
});

describe("closeHomeTab", () => {
  it("removes a matching live Chrome tab", async () => {
    const get = vi.fn().mockResolvedValue({ id: 42, url: "https://example.com/work", incognito: false });
    const remove = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", { tabs: { get, remove } });

    await expect(closeHomeTab(savedTab())).resolves.toBe("closed");
    expect(remove).toHaveBeenCalledWith(42);
  });

  it("does not remove when the live URL no longer matches", async () => {
    const get = vi.fn().mockResolvedValue({ id: 42, url: "https://other.example/", incognito: false });
    const remove = vi.fn();
    vi.stubGlobal("chrome", { tabs: { get, remove } });

    await expect(closeHomeTab(savedTab())).resolves.toBe("noop");
    expect(remove).not.toHaveBeenCalled();
  });

  it("treats an already-gone tab as closed", async () => {
    const remove = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { get: vi.fn().mockRejectedValue(new Error("No tab with id")), remove },
    });

    await expect(closeHomeTab(savedTab())).resolves.toBe("closed");
    expect(remove).not.toHaveBeenCalled();
  });

  it("no-ops when there is no live chromeTabId", async () => {
    await expect(closeHomeTab(savedTab({ chromeTabId: null }))).resolves.toBe("noop");
  });
});
