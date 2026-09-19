// End to end without a browser or a server: the real extension modules (collector,
// snapshotter, sender, store) send to the real ingest route handler, backed by the
// real schema. Only Chrome itself is faked.
//
// This is a .mts file on purpose: it imports code from apps/extension, which needs
// Chrome's type definitions that apps/web does not have, so it stays out of the
// web project's type check. vitest runs it all the same.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as ingestPost } from "@/app/api/ingest/tabs/route";
import { GET as resolveGet } from "@/app/api/resolve/route";
import { PUT as tabRefsPut } from "@/app/api/tab-refs/route";
import { POST as workspacesPost } from "@/app/api/workspaces/route";
import { query } from "@/src/db";
import { installChromeMock } from "../../../extension/tests/helpers/chrome-mock";
import { createCollector } from "../../../extension/src/collector";
import { createSender } from "../../../extension/src/sender";
import { createSnapshotter } from "../../../extension/src/snapshot";
import { createStore } from "../../../extension/src/store";
import { read, req, reset } from "../helpers";

const TOKEN = "extension-e2e-token-1";

type Handler = (request: Request) => Promise<Response>;
let route: Handler;
let mock: ReturnType<typeof installChromeMock>;
let store: ReturnType<typeof createStore>;
const fetchToRoute = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => route(new Request(String(input), init)));

beforeEach(async () => {
  await reset();
  mock = installChromeMock();
  store = createStore();
  route = ingestPost;
  fetchToRoute.mockClear();
});

function worker(token = TOKEN) {
  const snapshotter = createSnapshotter({ store });
  const sender = createSender({
    store,
    getConfig: () => ({ ok: true, config: { apiBaseUrl: "http://localhost", deviceToken: token } }),
    fetchFn: fetchToRoute as unknown as typeof fetch,
    takeFullSnapshot: () => snapshotter.takeFullSnapshot(),
    sampleActive: () => snapshotter.sampleActive(),
    random: () => 0.5,
  });
  const collector = createCollector({ store });
  return { snapshotter, sender, collector };
}

const page = (id: number, url: string, over: Record<string, unknown> = {}) => ({
  id,
  windowId: 1,
  url,
  title: `Title of ${url}`,
  active: false,
  ...over,
});

const db = {
  tabs: async () => (await query("SELECT url, chrome_tab_id, workspace_id, snippet FROM tab_refs ORDER BY url")).rows,
  eventTypes: async () => (await query("SELECT event_type FROM tab_events ORDER BY time, event_type")).rows.map((r) => r.event_type as string),
  eventCount: async () => (await query("SELECT count(*)::int AS n FROM tab_events")).rows[0].n as number,
  userCount: async () => (await query("SELECT count(*)::int AS n FROM users")).rows[0].n as number,
};

describe("the extension and the API, together", () => {
  it("the first batch after install reaches the database: a user, a record per tab, and an opened event each", async () => {
    mock.tabs = [page(1, "https://example.com/a", { active: true }), page(2, "https://example.com/b")];
    mock.scriptResults.set(1, "  A short   article about a ");
    const { sender } = worker();

    await store.updateState({ needsFullSnapshot: true });
    expect(await sender.drainOnce()).toMatchObject({ outcome: "sent", accepted: 2, duplicates: 0 });

    expect(await db.userCount()).toBe(1);
    expect(await db.tabs()).toMatchObject([
      { url: "https://example.com/a", chrome_tab_id: 1, workspace_id: null, snippet: "A short article about a" },
      { url: "https://example.com/b", chrome_tab_id: 2, workspace_id: null },
    ]);
    expect(await db.eventTypes()).toEqual(["opened", "opened"]);
    expect(await store.size()).toBe(0); // acknowledged, so the extension dropped its copy
    expect((await store.getState()).status).toBe("ok");
  });

  it("live changes flow through: a tab opens, settles, and closes, and its record and events follow", async () => {
    const { sender, collector } = worker();
    const tab = page(5, "https://example.com/live");
    mock.tabs = [tab];
    await collector.onTabCreated(tab);
    await collector.flushTab(5); // the settle wait, without waiting
    expect(await sender.drainOnce()).toMatchObject({ outcome: "sent" });
    expect(await db.tabs()).toMatchObject([{ url: "https://example.com/live", chrome_tab_id: 5 }]);

    mock.tabs = [];
    await collector.onTabRemoved(5);
    expect(await sender.drainOnce()).toMatchObject({ outcome: "sent" });
    expect(await db.eventTypes()).toEqual(["opened", "closed"]);
    expect((await db.tabs())[0].chrome_tab_id).toBeNull(); // the tab is gone, so its live id was released
  });

  it("an outage loses nothing, and the retry stores each event once", async () => {
    mock.tabs = [page(1, "https://example.com/a"), page(2, "https://example.com/b")];
    const { sender } = worker();
    await store.updateState({ needsFullSnapshot: true });

    route = () => Promise.reject(new TypeError("Failed to fetch"));
    expect(await sender.drainOnce()).toMatchObject({ outcome: "failed" });
    expect(await db.eventCount()).toBe(0);
    expect(await store.size()).toBe(2); // kept
    expect((await store.getState()).status).toBe("retrying");

    route = ingestPost;
    await store.updateState({ nextAttemptAt: null }); // skip the backoff wait
    expect(await sender.drainOnce()).toMatchObject({ outcome: "sent", accepted: 2, duplicates: 0 });
    expect(await db.eventCount()).toBe(2);
    expect(await store.size()).toBe(0);
  });

  it("a response lost after the server stored the batch: the resend is recognised, not duplicated", async () => {
    mock.tabs = [page(1, "https://example.com/a"), page(2, "https://example.com/b")];
    const { sender } = worker();
    await store.updateState({ needsFullSnapshot: true });

    route = async (request) => {
      await ingestPost(request); // the server processed and stored it ...
      throw new TypeError("connection reset"); // ... but the answer never arrived
    };
    expect(await sender.drainOnce()).toMatchObject({ outcome: "failed" });
    expect(await db.eventCount()).toBe(2);
    expect(await store.size()).toBe(2); // the extension cannot know, so it kept them

    route = ingestPost;
    await store.updateState({ nextAttemptAt: null });
    expect(await sender.drainOnce()).toMatchObject({ outcome: "sent", accepted: 0, duplicates: 2 });
    expect(await db.eventCount()).toBe(2); // still two, not four
    expect(await store.size()).toBe(0);
  });

  it("a browser restart: the same pages come back with new tab ids and keep their workspace", async () => {
    const papers = "https://papers.example/a";
    const news = "https://news.example/b";
    mock.tabs = [page(10, papers, { active: true }), page(11, news)];
    const { sender, snapshotter } = worker();
    await store.updateState({ needsFullSnapshot: true });
    await sender.drainOnce();

    // The user files one page under a workspace.
    const ws = (await read(workspacesPost(req("POST", "/api/workspaces", TOKEN, { name: "Research" })))).json.workspace;
    await read(tabRefsPut(req("PUT", "/api/tab-refs", TOKEN, { url: papers, workspaceId: ws.id, chromeTabId: 10 })));

    // Chrome restarts: the extension starts over, and the ids are swapped.
    await snapshotter.resetForBrowserStart();
    mock.tabs = [page(10, news), page(11, papers, { active: true })];
    await store.updateState({ needsFullSnapshot: true });
    expect(await sender.drainOnce()).toMatchObject({ outcome: "sent" });

    const rows = Object.fromEntries((await db.tabs()).map((r) => [r.url as string, r]));
    expect(Object.keys(rows)).toHaveLength(2); // no duplicate records
    expect(rows[papers]).toMatchObject({ workspace_id: ws.id, chrome_tab_id: 11 });
    expect(rows[news]).toMatchObject({ workspace_id: null, chrome_tab_id: 10 });

    // The sidebar's question, asked with this session's tab id:
    const answer = await read(resolveGet(req("GET", "/api/resolve?chromeTabId=11", TOKEN)));
    expect(answer.json.workspace.id).toBe(ws.id);
    const other = await read(resolveGet(req("GET", "/api/resolve?chromeTabId=10", TOKEN)));
    expect(other.json.workspace).toBeNull();
  });

  it("a device token the server cannot accept stops the extension without losing anything", async () => {
    mock.tabs = [page(1, "https://example.com/a")];
    const { sender } = worker("short"); // under 8 characters
    await store.updateState({ needsFullSnapshot: true });

    expect(await sender.drainOnce()).toEqual({ outcome: "auth_failed" });
    expect(await db.userCount()).toBe(0);
    expect(await db.eventCount()).toBe(0);
    expect(await store.size()).toBe(1);
    expect((await store.getState()).status).toBe("auth_failed");
  });

  it("sends only what the server accepts: real snapshots and events all pass validation", async () => {
    const tabs = Array.from({ length: 30 }, (_, i) => page(i + 1, `https://example.com/${i}`, { active: i === 0 }));
    mock.tabs = tabs;
    for (const t of tabs) mock.scriptResults.set(t.id, "text ".repeat(600)); // longer than the limit
    const { sender } = worker();
    await store.updateState({ needsFullSnapshot: true });

    expect(await sender.drainOnce()).toMatchObject({ outcome: "sent", accepted: 30 });
    expect((await db.tabs()).every((r) => (r.snippet as string).length <= 2000)).toBe(true);
    expect(fetchToRoute).toHaveBeenCalledTimes(1); // one request, no bisecting because nothing was rejected
  });
});
