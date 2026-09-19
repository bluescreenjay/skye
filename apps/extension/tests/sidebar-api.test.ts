import { describe, expect, it, vi } from "vitest";
import type { TabRef, Workspace } from "@ai-browser/shared";
import { fetchPanelView } from "../src/sidebar/api";

const page = { tabId: 23, windowId: 2, url: "https://example.com/current" };
const config = { apiBaseUrl: "http://127.0.0.1:3000", deviceToken: "device-token" };
const workspace: Workspace = {
  id: "workspace-1", userId: "user-1", name: "Research", emoji: "📚",
  status: "active", createdAt: "", updatedAt: "",
};
const tab = (id: string, workspaceId: string | null): TabRef => ({
  id, userId: "user-1", workspaceId, url: `https://example.com/${id}`,
  title: id, snippet: "", chromeTabId: null, lastSeenAt: "", placementSource: null,
});
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("fetchPanelView", () => {
  it("uses live tab identity, filters saved members, and sends the device token", async () => {
    const closed = tab("closed", workspace.id);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply({ workspace, tabRef: { ...tab("current", workspace.id), chromeTabId: page.tabId } }))
      .mockResolvedValueOnce(reply({ tabRefs: [closed, tab("wrong", null)] }));

    const view = await fetchPanelView(page, config, undefined, fetchImpl);
    expect(view.kind).toBe("named");
    if (view.kind === "named") expect(view.tabs).toEqual([closed]);
    expect(fetchImpl.mock.calls[0][0]).toContain("chromeTabId=23");
    expect(fetchImpl.mock.calls[0][0]).toContain("url=https%3A%2F%2Fexample.com%2Fcurrent");
    expect(fetchImpl.mock.calls[1][0]).toContain("workspaceId=workspace-1");
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer device-token");
  });

  it("shows Other for a page that has no saved reference", async () => {
    const other = tab("other", null);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply({ workspace: null, tabRef: null }))
      .mockResolvedValueOnce(reply({ tabRefs: [other, tab("wrong", workspace.id)] }));
    const view = await fetchPanelView(page, config, undefined, fetchImpl);
    expect(view.kind).toBe("other");
    if (view.kind === "other") expect(view.tabs).toEqual([other]);
    expect(fetchImpl.mock.calls[1][0]).toContain("other=true");
  });

  it("does not show an archived or mismatched workspace", async () => {
    for (const resolvedWorkspace of [{ ...workspace, status: "archived" }, workspace]) {
      const ref = tab("current", resolvedWorkspace.status === "archived" ? workspace.id : "other-workspace");
      const fetchImpl = vi.fn().mockResolvedValue(reply({ workspace: resolvedWorkspace, tabRef: ref }));
      const view = await fetchPanelView(page, config, undefined, fetchImpl);
      expect(view.kind).toBe("unavailable");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("does not show the previous page's workspace while a live tab navigates", async () => {
    const oldRef = { ...tab("old", workspace.id), chromeTabId: page.tabId };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply({ workspace, tabRef: oldRef }))
      .mockResolvedValueOnce(reply({ workspace: null, tabRef: null }))
      .mockResolvedValueOnce(reply({ tabRefs: [] }));
    const view = await fetchPanelView(page, config, undefined, fetchImpl);
    expect(view.kind).toBe("other");
    expect(fetchImpl.mock.calls[1][0]).toContain("/api/resolve?url=");
    expect(fetchImpl.mock.calls[1][0]).not.toContain("chromeTabId=");
  });

  it("clears to unavailable on an authentication error", async () => {
    const view = await fetchPanelView(page, config, undefined, vi.fn().mockResolvedValue(reply({ error: "no" }, 401)));
    expect(view.kind).toBe("unavailable");
  });
});
