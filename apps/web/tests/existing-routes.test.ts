import { beforeEach, describe, expect, it } from "vitest";
import { POST as ingestPost } from "@/app/api/ingest/tabs/route";
import { GET as resolveGet } from "@/app/api/resolve/route";
import { POST as sessionPost } from "@/app/api/session/route";
import { GET as tabEventsGet, POST as tabEventsPost } from "@/app/api/tab-events/route";
import { PATCH as tabRefPatch } from "@/app/api/tab-refs/[id]/route";
import { GET as tabRefsGet, PUT as tabRefsPut } from "@/app/api/tab-refs/route";
import { GET as workspaceGet, PATCH as workspacePatch } from "@/app/api/workspaces/[id]/route";
import { GET as workspacesGet, POST as workspacesPost } from "@/app/api/workspaces/route";
import { query } from "@/src/db";
import { batch, read, req, reset, tab } from "./helpers";

const ALICE = "alice-device-token-0001";
const BOB = "bob-device-token-000002";

beforeEach(reset);

const pair = (token: string) => read(sessionPost(req("POST", "/api/session", null, { deviceToken: token })));
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const createWorkspace = async (token: string, name = "Hackathon") =>
  (await read(workspacesPost(req("POST", "/api/workspaces", token, { name, emoji: "💻" })))).json.workspace;
const putTab = (token: string, body: Record<string, unknown>) => read(tabRefsPut(req("PUT", "/api/tab-refs", token, body)));
const listTabs = async (token: string) => (await read(tabRefsGet(req("GET", "/api/tab-refs", token)))).json.tabRefs;
const resolveTab = (token: string, qs: string) => read(resolveGet(req("GET", `/api/resolve?${qs}`, token)));

describe("pairing and auth (feature 003, unchanged behaviour)", () => {
  it("the same token is the same user; a different token is a different user", async () => {
    const a1 = await pair(ALICE);
    const a2 = await pair(ALICE);
    const b = await pair(BOB);
    expect(a1.json.userId).toBeTruthy();
    expect(a2.json.userId).toBe(a1.json.userId);
    expect(b.json.userId).not.toBe(a1.json.userId);
    expect((await query("SELECT count(*)::int AS n FROM users")).rows[0].n).toBe(2);
  });

  it("rejects a token that is too short (400)", async () => {
    expect((await pair("short")).status).toBe(400);
  });

  it("rejects a request with no bearer token, and one with a token that never paired (401)", async () => {
    expect((await read(workspacesGet(req("GET", "/api/workspaces", null)))).status).toBe(401);
    expect((await read(workspacesGet(req("GET", "/api/workspaces", "never-paired-token-xx")))).status).toBe(401);
  });
});

describe("workspaces (feature 003, unchanged behaviour)", () => {
  beforeEach(async () => {
    await pair(ALICE);
    await pair(BOB);
  });

  it("creates with the shared-type fields and validates the name", async () => {
    const ws = await createWorkspace(ALICE);
    expect(Object.keys(ws).sort()).toEqual(["createdAt", "emoji", "id", "name", "status", "updatedAt", "userId"]);
    expect(ws).toMatchObject({ name: "Hackathon", status: "active" });
    expect((await read(workspacesPost(req("POST", "/api/workspaces", ALICE, { name: "" })))).status).toBe(400);
    expect((await read(workspacesPost(req("POST", "/api/workspaces", ALICE, { name: "x".repeat(81) })))).status).toBe(400);
  });

  it("keeps each user's workspaces private", async () => {
    const ws = await createWorkspace(ALICE);
    const bobList = (await read(workspacesGet(req("GET", "/api/workspaces", BOB)))).json.workspaces;
    expect(bobList.some((w: { id: string }) => w.id === ws.id)).toBe(false);
    expect((await read(workspaceGet(req("GET", "/x", BOB), ctx(ws.id)))).status).toBe(404);
    expect([403, 404]).toContain((await read(workspacePatch(req("PATCH", "/x", BOB, { name: "hax" }), ctx(ws.id)))).status);
  });

  it("renames, archives (hidden from the default list, still retrievable), and lists archived on request", async () => {
    const ws = await createWorkspace(ALICE);
    const renamed = await read(workspacePatch(req("PATCH", "/x", ALICE, { name: "Renamed" }), ctx(ws.id)));
    expect(renamed.json.workspace.name).toBe("Renamed");

    await read(workspacePatch(req("PATCH", "/x", ALICE, { status: "archived" }), ctx(ws.id)));
    const def = (await read(workspacesGet(req("GET", "/api/workspaces", ALICE)))).json.workspaces;
    expect(def.some((w: { id: string }) => w.id === ws.id)).toBe(false);
    expect((await read(workspaceGet(req("GET", "/x", ALICE), ctx(ws.id)))).status).toBe(200);
    const all = (await read(workspacesGet(req("GET", "/api/workspaces?includeArchived=true", ALICE)))).json.workspaces;
    expect(all.some((w: { id: string }) => w.id === ws.id)).toBe(true);
  });
});

describe("tab records, resolve, and events (feature 003)", () => {
  beforeEach(async () => {
    await pair(ALICE);
    await pair(BOB);
  });

  it("assigns a tab to a workspace or to Other, and resolves it for the sidebar", async () => {
    const ws = await createWorkspace(ALICE);
    await putTab(ALICE, { url: "https://github.com", title: "GitHub", chromeTabId: 1, workspaceId: ws.id });
    await putTab(ALICE, { url: "https://youtube.com", title: "YouTube", chromeTabId: 2, workspaceId: null });

    expect((await resolveTab(ALICE, "chromeTabId=1")).json.workspace.id).toBe(ws.id);
    const other = await resolveTab(ALICE, "chromeTabId=2");
    expect(other.status).toBe(200);
    expect(other.json.workspace).toBeNull();
    expect(other.json.tabRef).toBeTruthy();
    expect((await resolveTab(ALICE, `url=${encodeURIComponent("https://github.com")}`)).json.workspace.id).toBe(ws.id);
  });

  it("keeps another user's records and workspaces out of reach", async () => {
    const ws = await createWorkspace(ALICE);
    await putTab(ALICE, { url: "https://github.com", chromeTabId: 1, workspaceId: ws.id });
    expect((await putTab(BOB, { url: "https://x.com", chromeTabId: 9, workspaceId: ws.id })).status).toBe(400);
    expect((await resolveTab(BOB, "chromeTabId=1")).json.tabRef).toBeNull();
    expect(await listTabs(BOB)).toEqual([]);
  });

  it("appends events and lists only the caller's", async () => {
    const saved = await putTab(ALICE, { url: "https://github.com", title: "GitHub", chromeTabId: 1 });
    const posted = await read(
      tabEventsPost(req("POST", "/api/tab-events", ALICE, { eventType: "opened", url: "https://github.com", chromeTabId: 1, tabRefId: saved.json.tabRef.id })),
    );
    expect(posted.status).toBe(201);
    expect((await read(tabEventsGet(req("GET", "/api/tab-events", ALICE)))).json.tabEvents).toHaveLength(1);
    expect((await read(tabEventsGet(req("GET", "/api/tab-events", BOB)))).json.tabEvents).toHaveLength(0);
    expect((await read(tabEventsPost(req("POST", "/api/tab-events", ALICE, { eventType: "exploded" })))).status).toBe(400);
  });
});

describe("PUT /api/tab-refs follows the address, not Chrome's tab id", () => {
  beforeEach(async () => {
    await pair(ALICE);
  });

  it("updates the record for the same address instead of adding another", async () => {
    await putTab(ALICE, { url: "https://a.example/", title: "Old", chromeTabId: 10 });
    await putTab(ALICE, { url: "https://a.example/", title: "New", chromeTabId: 10 });
    const tabs = await listTabs(ALICE);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].title).toBe("New");
  });

  it("a page keeps its workspace when a restart gives it a different tab id", async () => {
    const ws = await createWorkspace(ALICE);
    await putTab(ALICE, { url: "https://papers.example/a", chromeTabId: 10, workspaceId: ws.id });
    await putTab(ALICE, { url: "https://papers.example/a", chromeTabId: 900 }); // after a restart
    const tabs = await listTabs(ALICE);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ workspaceId: ws.id, chromeTabId: 900 });
    expect((await resolveTab(ALICE, "chromeTabId=900")).json.workspace.id).toBe(ws.id);
  });

  it("does not let a reused tab id carry one page's workspace onto another page", async () => {
    const ws = await createWorkspace(ALICE);
    await putTab(ALICE, { url: "https://papers.example/a", chromeTabId: 10, workspaceId: ws.id });
    await putTab(ALICE, { url: "https://news.example/b", chromeTabId: 11, workspaceId: null });
    // restart: the two pages come back with the ids swapped
    await putTab(ALICE, { url: "https://news.example/b", chromeTabId: 10 });
    await putTab(ALICE, { url: "https://papers.example/a", chromeTabId: 11 });

    const byUrl = Object.fromEntries((await listTabs(ALICE)).map((t: { url: string }) => [t.url, t]));
    expect(byUrl["https://papers.example/a"].workspaceId).toBe(ws.id);
    expect(byUrl["https://news.example/b"].workspaceId).toBeNull();
    expect(byUrl["https://news.example/b"].chromeTabId).toBe(10);
    expect(byUrl["https://papers.example/a"].chromeTabId).toBe(11);
  });

  it("a tab id is held by one record at a time", async () => {
    await putTab(ALICE, { url: "https://one.example/", chromeTabId: 5 });
    await putTab(ALICE, { url: "https://two.example/", chromeTabId: 5 });
    const holders = (await listTabs(ALICE)).filter((t: { chromeTabId: number | null }) => t.chromeTabId === 5);
    expect(holders.map((t: { url: string }) => t.url)).toEqual(["https://two.example/"]);
  });

  it("still finds a record by its own id", async () => {
    const first = await putTab(ALICE, { url: "https://a.example/", title: "A", chromeTabId: 1 });
    const again = await putTab(ALICE, { id: first.json.tabRef.id, url: "https://a.example/renamed", title: "A2", chromeTabId: 1 });
    expect(again.json.tabRef.id).toBe(first.json.tabRef.id);
    expect(await listTabs(ALICE)).toHaveLength(1);
  });
});

describe("placement source (feature 004): who placed a tab", () => {
  beforeEach(async () => {
    await pair(ALICE);
  });

  const only = async (url: string) => (await listTabs(ALICE)).find((t: { url: string }) => t.url === url);

  it("a tab that arrives from the extension has never been placed", async () => {
    const reply = await read(ingestPost(req("POST", "/api/ingest/tabs", ALICE, batch({ tabs: [tab(1, "https://a.example/")] }))));
    expect(reply.status).toBe(200);
    const stored = await only("https://a.example/");
    expect(stored.placementSource).toBeNull();
    expect(stored.workspaceId).toBeNull();
  });

  it("PUT with a workspaceId, or with null (Other), is the user's decision", async () => {
    const ws = await createWorkspace(ALICE);
    expect((await putTab(ALICE, { url: "https://a.example/", workspaceId: ws.id })).json.tabRef.placementSource).toBe("user");
    // a new tab put straight into Other is a decision too: it must not be clustered later
    expect((await putTab(ALICE, { url: "https://b.example/", workspaceId: null })).json.tabRef.placementSource).toBe("user");
  });

  it("PUT without a workspaceId leaves an unplaced tab unplaced and a placed tab as it was", async () => {
    const ws = await createWorkspace(ALICE);
    expect((await putTab(ALICE, { url: "https://a.example/", title: "one" })).json.tabRef.placementSource).toBeNull();
    expect((await putTab(ALICE, { url: "https://a.example/", title: "two" })).json.tabRef.placementSource).toBeNull();
    await putTab(ALICE, { url: "https://c.example/", workspaceId: ws.id });
    const refreshed = await putTab(ALICE, { url: "https://c.example/", title: "renamed page" });
    expect(refreshed.json.tabRef).toMatchObject({ placementSource: "user", workspaceId: ws.id });
  });

  it("PATCH with a workspaceId, or with null, is the user's decision; without one it is not", async () => {
    const ws = await createWorkspace(ALICE);
    const id = (await putTab(ALICE, { url: "https://a.example/" })).json.tabRef.id;
    const retitled = await read(tabRefPatch(req("PATCH", "/x", ALICE, { title: "new title" }), ctx(id)));
    expect(retitled.json.tabRef.placementSource).toBeNull();
    const moved = await read(tabRefPatch(req("PATCH", "/x", ALICE, { workspaceId: ws.id }), ctx(id)));
    expect(moved.json.tabRef).toMatchObject({ workspaceId: ws.id, placementSource: "user" });
    const toOther = await read(tabRefPatch(req("PATCH", "/x", ALICE, { workspaceId: null }), ctx(id)));
    expect(toOther.json.tabRef).toMatchObject({ workspaceId: null, placementSource: "user" });
  });

  it("ingesting a placed tab again does not change who placed it", async () => {
    const ws = await createWorkspace(ALICE);
    await putTab(ALICE, { url: "https://a.example/", workspaceId: ws.id });
    await read(ingestPost(req("POST", "/api/ingest/tabs", ALICE, batch({ tabs: [tab(1, "https://a.example/")] }))));
    expect(await only("https://a.example/")).toMatchObject({ placementSource: "user", workspaceId: ws.id });
  });

  it("GET /api/resolve and GET /api/tab-refs carry the field", async () => {
    const ws = await createWorkspace(ALICE);
    await putTab(ALICE, { url: "https://a.example/", chromeTabId: 7, workspaceId: ws.id });
    expect((await resolveTab(ALICE, "chromeTabId=7")).json.tabRef.placementSource).toBe("user");
    const listed = (await read(tabRefsGet(req("GET", "/api/tab-refs?other=true", ALICE)))).json.tabRefs;
    expect(listed).toEqual([]);
    expect((await listTabs(ALICE))[0]).toHaveProperty("placementSource", "user");
  });
});
