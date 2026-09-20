import { beforeEach, describe, expect, it, vi } from "vitest";
import { showHome } from "../src/home/navigation";
import { SIGNAL_KEY, type CommandSignal } from "../src/ui/command-signal";
import { installChromeMock, type ChromeMock } from "./helpers/chrome-mock";

let mock: ChromeMock;
const HOME = "chrome-extension://test-extension-id/home.html";
const signal = () => mock.session.get(SIGNAL_KEY) as CommandSignal | undefined;

beforeEach(() => {
  mock = installChromeMock();
  (chrome.windows as unknown as { update: unknown }).update = vi.fn(async () => undefined);
  (chrome.tabs as unknown as { update: unknown }).update = vi.fn(async () => undefined);
});

describe("showHome", () => {
  it("focuses an existing Home tab (without opening another) and sends a navigate signal", async () => {
    mock.tabs = [{ id: 1, windowId: 1, url: HOME }];
    (chrome.tabs as unknown as { query: unknown }).query = vi.fn(async () => [{ id: 1, windowId: 1, url: HOME }]);
    await showHome({ kind: "workspace", workspaceId: "w-1" });
    expect(mock.createdTabs).toEqual([]);
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
    expect(signal()).toMatchObject({ kind: "navigate", target: { kind: "workspace", workspaceId: "w-1" } });
  });

  it("opens Home when there is none, and still sends the signal", async () => {
    (chrome.tabs as unknown as { query: unknown }).query = vi.fn(async () => []);
    await showHome({ kind: "home" });
    expect(mock.createdTabs).toEqual([{ url: HOME }]);
    expect(signal()).toMatchObject({ kind: "navigate", target: { kind: "home" } });
  });

  it("opens Home even when looking for it fails, and never throws", async () => {
    (chrome.tabs as unknown as { query: unknown }).query = vi.fn(async () => {
      throw new Error("nope");
    });
    await expect(showHome({ kind: "home" })).resolves.toBeUndefined();
    expect(mock.createdTabs).toEqual([{ url: HOME }]);
  });

  it("does not remove a window or a tab (the Side Panel stays open, and nothing is closed)", async () => {
    (chrome.tabs as unknown as { query: unknown }).query = vi.fn(async () => []);
    const removeWindow = vi.fn();
    (chrome.windows as unknown as { remove: unknown }).remove = removeWindow;
    await showHome({ kind: "home" });
    expect(removeWindow).not.toHaveBeenCalled();
    expect(mock.removedTabs).toEqual([]);
  });
});
