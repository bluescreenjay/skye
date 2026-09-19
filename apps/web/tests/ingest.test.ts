import { beforeEach, describe, expect, it } from "vitest";
import { POST as ingestPost } from "@/app/api/ingest/tabs/route";
import { GET as resolveGet } from "@/app/api/resolve/route";
import { GET as tabEventsGet } from "@/app/api/tab-events/route";
import { GET as tabRefsGet, PUT as tabRefsPut } from "@/app/api/tab-refs/route";
import { POST as workspacesPost } from "@/app/api/workspaces/route";
import { query } from "@/src/db";
import { batch, event, read, req, reset, tab, uuid } from "./helpers";

const ALICE = "alice-device-token-0001";
const BOB = "bob-device-token-000002";

beforeEach(reset);

const ingest = (token: string | null, body: unknown) => read(ingestPost(req("POST", "/api/ingest/tabs", token, body)));
type TabRow = { id: string; url: string; title: string; snippet: string; chromeTabId: number | null; workspaceId: string | null };
type EventRow = { id: string; url: string; tabRefId: string | null; workspaceId: string | null };

const tabs = async (token: string): Promise<TabRow[]> => (await read(tabRefsGet(req("GET", "/api/tab-refs", token)))).json.tabRefs;
const events = async (token: string, limit = 200): Promise<EventRow[]> =>
  (await read(tabEventsGet(req("GET", `/api/tab-events?limit=${limit}`, token)))).json.tabEvents;
const resolveTab = (token: string, qs: string) => read(resolveGet(req("GET", `/api/resolve?${qs}`, token)));
const byUrl = <T extends { url: string }>(list: T[]): Record<string, T> => Object.fromEntries(list.map((t) => [t.url, t]));
const userCount = async () => (await query("SELECT count(*)::int AS n FROM users")).rows[0].n as number;
/** Rows in the whole database: a rejected batch has no user yet, so it cannot be read back through the API. */
const stored = async () => ({
  tabs: (await query("SELECT count(*)::int AS n FROM tab_refs")).rows[0].n as number,
  events: (await query("SELECT count(*)::int AS n FROM tab_events")).rows[0].n as number,
});

async function workspaceFor(token: string, name = "Research") {
  return (await read(workspacesPost(req("POST", "/api/workspaces", token, { name })))).json.workspace as { id: string };
}
const assign = (token: string, url: string, workspaceId: string | null, chromeTabId: number | null = null) =>
  read(tabRefsPut(req("PUT", "/api/tab-refs", token, { url, workspaceId, chromeTabId })));

describe("who is calling", () => {
  it("rejects a request with no bearer token (401)", async () => {
    expect((await ingest(null, batch())).status).toBe(401);
  });

  it("rejects a token that is too short (401), and creates no user", async () => {
    const res = await ingest("short", batch());
    expect(res.status).toBe(401);
    expect(await userCount()).toBe(0);
  });

  it("creates the user the first time a valid token is seen, and reuses it afterwards", async () => {
    expect(await userCount()).toBe(0);
    expect((await ingest(ALICE, batch())).status).toBe(200);
    expect(await userCount()).toBe(1);
    expect((await ingest(ALICE, batch())).status).toBe(200);
    expect(await userCount()).toBe(1);
  });

  it("does not create a user for a request whose body is invalid", async () => {
    expect((await ingest(ALICE, { nonsense: true })).status).toBe(400);
    expect(await userCount()).toBe(0);
  });
});

describe("storing tabs and events", () => {
  it("stores each snapshot as a record in Other and each event linked to its record", async () => {
    const a = "https://example.com/a";
    const b = "https://example.com/b";
    const res = await ingest(
      ALICE,
      batch({
        tabs: [tab(1, a, { title: "A", snippet: "about a", active: true }), tab(2, b, { title: "B" })],
        events: [event(1, a, "opened"), event(2, b, "opened")],
      }),
    );
    expect(res).toMatchObject({ status: 200, json: { accepted: 2, duplicates: 0 } });

    const stored = byUrl(await tabs(ALICE));
    expect(stored[a]).toMatchObject({ title: "A", snippet: "about a", chromeTabId: 1, workspaceId: null });
    expect(stored[b]).toMatchObject({ title: "B", chromeTabId: 2, workspaceId: null });

    const list = await events(ALICE);
    expect(list).toHaveLength(2);
    for (const e of list) expect(e.tabRefId).toBe(stored[e.url].id);
  });

  it("answers the sidebar's question: which workspace is this tab in?", async () => {
    const url = "https://papers.example/a";
    await ingest(ALICE, batch({ tabs: [tab(7, url)] }));
    const ws = await workspaceFor(ALICE);
    await assign(ALICE, url, ws.id, 7);
    expect((await resolveTab(ALICE, "chromeTabId=7")).json.workspace.id).toBe(ws.id);
  });

  it("puts an event's workspace as the record's membership at that moment", async () => {
    const url = "https://papers.example/a";
    await ingest(ALICE, batch({ tabs: [tab(1, url)] }));
    const ws = await workspaceFor(ALICE);
    await assign(ALICE, url, ws.id, 1);
    await ingest(ALICE, batch({ events: [event(1, url, "activated")] }));
    expect((await events(ALICE))[0].workspaceId).toBe(ws.id);
  });

  it("accepts the per-request active-tab sample without storing it as a record", async () => {
    const res = await ingest(ALICE, batch({ active: { windowId: 3, chromeTabId: 9 } }));
    expect(res.status).toBe(200);
    expect(await tabs(ALICE)).toEqual([]);
  });

  it("stores an event that has no record yet (a closed tab that was never snapshotted)", async () => {
    const res = await ingest(ALICE, batch({ events: [event(4, "https://gone.example/", "closed")] }));
    expect(res.json).toEqual({ accepted: 1, duplicates: 0 });
    expect((await events(ALICE))[0].tabRefId).toBeNull();
  });
});

describe("retries: every event is counted once", () => {
  it("re-sending the same batch adds nothing and reports the duplicates", async () => {
    const body = batch({
      tabs: [tab(1, "https://example.com/a")],
      events: [event(1, "https://example.com/a", "opened"), event(1, "https://example.com/a", "updated")],
    });
    expect((await ingest(ALICE, body)).json).toEqual({ accepted: 2, duplicates: 0 });
    expect((await ingest(ALICE, body)).json).toEqual({ accepted: 0, duplicates: 2 });
    expect(await events(ALICE)).toHaveLength(2);
    expect(await tabs(ALICE)).toHaveLength(1);
  });

  it("a retry that carries new events as well counts only the new ones", async () => {
    const first = event(1, "https://example.com/a", "opened");
    await ingest(ALICE, batch({ events: [first] }));
    const res = await ingest(ALICE, batch({ events: [first, event(1, "https://example.com/a", "updated")] }));
    expect(res.json).toEqual({ accepted: 1, duplicates: 1 });
    expect(await events(ALICE)).toHaveLength(2);
  });

  it("the same event id twice inside one batch is stored once", async () => {
    const e = event(1, "https://example.com/a");
    expect((await ingest(ALICE, batch({ events: [e, e] }))).json).toEqual({ accepted: 1, duplicates: 1 });
  });
});

describe("a browser restart: Chrome hands out new tab ids", () => {
  it("keeps a page's record and workspace when its tab id changes", async () => {
    const url = "https://papers.example/a";
    await ingest(ALICE, batch({ fullSnapshot: true, tabs: [tab(10, url)] }));
    const ws = await workspaceFor(ALICE);
    await assign(ALICE, url, ws.id, 10);

    await ingest(ALICE, batch({ fullSnapshot: true, tabs: [tab(900, url)] })); // after the restart
    const all = await tabs(ALICE);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ workspaceId: ws.id, chromeTabId: 900 });
    expect((await resolveTab(ALICE, "chromeTabId=900")).json.workspace.id).toBe(ws.id);
  });

  it("does not swap workspaces when two pages come back with each other's old ids", async () => {
    const papers = "https://papers.example/a";
    const news = "https://news.example/b";
    await ingest(ALICE, batch({ fullSnapshot: true, tabs: [tab(10, papers), tab(11, news)] }));
    const ws = await workspaceFor(ALICE);
    await assign(ALICE, papers, ws.id, 10);

    await ingest(ALICE, batch({ fullSnapshot: true, tabs: [tab(10, news), tab(11, papers)] }));
    const stored = byUrl(await tabs(ALICE));
    expect(stored[papers]).toMatchObject({ workspaceId: ws.id, chromeTabId: 11 });
    expect(stored[news]).toMatchObject({ workspaceId: null, chromeTabId: 10 });
  });

  it("a reused tab id leaves the page that used to hold it, even without a full snapshot", async () => {
    await ingest(ALICE, batch({ tabs: [tab(10, "https://old.example/")] }));
    await ingest(ALICE, batch({ tabs: [tab(10, "https://new.example/")] }));
    const stored = byUrl(await tabs(ALICE));
    expect(stored["https://new.example/"].chromeTabId).toBe(10);
    expect(stored["https://old.example/"].chromeTabId).toBeNull();
  });
});

describe("full snapshots and closing tabs", () => {
  it("a full snapshot clears the tab id of every record it does not list", async () => {
    await ingest(ALICE, batch({ tabs: [tab(1, "https://a.example/"), tab(2, "https://b.example/")] }));
    await ingest(ALICE, batch({ fullSnapshot: true, tabs: [tab(1, "https://a.example/")] }));
    const stored = byUrl(await tabs(ALICE));
    expect(stored["https://a.example/"].chromeTabId).toBe(1);
    expect(stored["https://b.example/"].chromeTabId).toBeNull();
  });

  it("a full snapshot with no tabs clears every id (the browser has nothing open)", async () => {
    await ingest(ALICE, batch({ tabs: [tab(1, "https://a.example/")] }));
    await ingest(ALICE, batch({ fullSnapshot: true }));
    expect((await tabs(ALICE))[0].chromeTabId).toBeNull();
  });

  it("an ordinary snapshot leaves the ids of tabs it does not mention alone", async () => {
    await ingest(ALICE, batch({ tabs: [tab(1, "https://a.example/"), tab(2, "https://b.example/")] }));
    await ingest(ALICE, batch({ tabs: [tab(1, "https://a.example/")] }));
    expect(byUrl(await tabs(ALICE))["https://b.example/"].chromeTabId).toBe(2);
  });

  it("a closed event releases the tab id", async () => {
    const url = "https://a.example/";
    await ingest(ALICE, batch({ tabs: [tab(1, url, { lastSeenAt: new Date(Date.now() - 5000).toISOString() })] }));
    await ingest(ALICE, batch({ events: [event(1, url, "closed")] }));
    expect((await tabs(ALICE))[0].chromeTabId).toBeNull();
  });

  it("a closed event older than the record's last sighting does not release the id", async () => {
    const url = "https://a.example/";
    const closedAt = new Date(Date.now() - 60_000).toISOString();
    await ingest(ALICE, batch({ tabs: [tab(1, url, { lastSeenAt: new Date().toISOString() })] }));
    await ingest(ALICE, batch({ events: [event(1, url, "closed", { time: closedAt })] }));
    expect((await tabs(ALICE))[0].chromeTabId).toBe(1);
  });

  it("a closed event for a tab id the record no longer holds changes nothing", async () => {
    const url = "https://a.example/";
    await ingest(ALICE, batch({ tabs: [tab(5, url)] }));
    await ingest(ALICE, batch({ events: [event(99, url, "closed")] }));
    expect((await tabs(ALICE))[0].chromeTabId).toBe(5);
  });
});

describe("snippets and titles", () => {
  it("an empty snippet never overwrites a stored one, but a new one replaces it", async () => {
    const url = "https://a.example/";
    await ingest(ALICE, batch({ tabs: [tab(1, url, { snippet: "the article text" })] }));
    await ingest(ALICE, batch({ tabs: [tab(1, url, { snippet: "", title: "New title" })] }));
    expect((await tabs(ALICE))[0]).toMatchObject({ snippet: "the article text", title: "New title" });
    await ingest(ALICE, batch({ tabs: [tab(1, url, { snippet: "updated text" })] }));
    expect((await tabs(ALICE))[0].snippet).toBe("updated text");
  });

  it("two tabs on the same page share one record, bound to the tab seen last", async () => {
    const url = "https://same.example/";
    await ingest(ALICE, batch({ tabs: [tab(1, url), tab(2, url)] }));
    const all = await tabs(ALICE);
    expect(all).toHaveLength(1);
    expect(all[0].chromeTabId).toBe(2);
  });
});

describe("each user sees only their own data", () => {
  it("keeps two users' records and events apart, even for the same address", async () => {
    const url = "https://shared.example/";
    await ingest(ALICE, batch({ tabs: [tab(1, url)], events: [event(1, url)] }));
    await ingest(BOB, batch({ tabs: [tab(1, url)], events: [event(1, url)] }));
    expect(await userCount()).toBe(2);
    expect(await tabs(ALICE)).toHaveLength(1);
    expect(await tabs(BOB)).toHaveLength(1);
    expect((await tabs(ALICE))[0].id).not.toBe((await tabs(BOB))[0].id);
    expect(await events(ALICE)).toHaveLength(1);
    expect(await events(BOB)).toHaveLength(1);
  });

  it("one user's full snapshot never clears another user's tab ids", async () => {
    await ingest(ALICE, batch({ tabs: [tab(1, "https://a.example/")] }));
    await ingest(BOB, batch({ fullSnapshot: true }));
    expect((await tabs(ALICE))[0].chromeTabId).toBe(1);
  });

  it("one user's tab id never displaces another user's", async () => {
    await ingest(ALICE, batch({ tabs: [tab(1, "https://a.example/")] }));
    await ingest(BOB, batch({ tabs: [tab(1, "https://b.example/")] }));
    expect((await tabs(ALICE))[0].chromeTabId).toBe(1);
    expect((await tabs(BOB))[0].chromeTabId).toBe(1);
  });
});

describe("bad requests", () => {
  const rejects = async (mutate: (b: ReturnType<typeof batch>) => unknown, status = 400) => {
    const res = await ingest(ALICE, mutate(batch()));
    expect(res.status).toBe(status);
    expect(await stored()).toEqual({ tabs: 0, events: 0 }); // nothing was stored
    expect(await userCount()).toBe(0);
  };

  it.each([
    ["a body that is not an object", () => [1, 2]],
    ["a missing batchId", (b: object) => ({ ...b, batchId: "" })],
    ["a bad sentAt", (b: object) => ({ ...b, sentAt: "yesterday-ish" })],
    ["a non-boolean fullSnapshot", (b: object) => ({ ...b, fullSnapshot: "yes" })],
    ["tabs that are not an array", (b: object) => ({ ...b, tabs: {} })],
    ["a tab with a non-web address", (b: object) => ({ ...b, tabs: [tab(1, "chrome://settings")] })],
    ["a tab with a non-integer id", (b: object) => ({ ...b, tabs: [tab(1.5, "https://a.example/")] })],
    ["an event with an id that is not a UUID", (b: object) => ({ ...b, events: [event(1, "https://a.example/", "opened", { id: "nope" })] })],
    ["an event of the type reassigned, which only workspace features use", (b: object) => ({ ...b, events: [event(1, "https://a.example/", "reassigned")] })],
    ["an event with an unknown type", (b: object) => ({ ...b, events: [event(1, "https://a.example/", "exploded")] })],
    ["an event with a non-web address", (b: object) => ({ ...b, events: [event(1, "file:///etc/passwd")] })],
  ])("rejects %s (400) and stores nothing", async (_name, mutate) => {
    await rejects(mutate as (b: ReturnType<typeof batch>) => unknown);
  });

  it("rejects the whole batch when one item in it is bad, so nothing is half-applied", async () => {
    const res = await ingest(
      ALICE,
      batch({ tabs: [tab(1, "https://good.example/")], events: [event(1, "https://good.example/"), event(2, "chrome://bad")] }),
    );
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("events[1]");
    expect(await stored()).toEqual({ tabs: 0, events: 0 });
  });

  it("names the item that was bad, so the extension can isolate it", async () => {
    const res = await ingest(ALICE, batch({ events: [event(1, "https://a.example/"), event(1, "https://a.example/", "opened", { id: "x" })] }));
    expect(res.json.error).toContain("events[1].id");
  });

  it("answers 413 for more than 100 events, and for more than 500 tabs", async () => {
    await rejects((b) => ({ ...b, events: Array.from({ length: 101 }, () => event(1, "https://a.example/")) }), 413);
    await rejects((b) => ({ ...b, tabs: Array.from({ length: 501 }, (_, i) => tab(i, `https://a.example/${i}`)) }), 413);
  });

  it("accepts exactly 100 events and 500 tabs", async () => {
    const res = await ingest(
      ALICE,
      batch({
        tabs: Array.from({ length: 500 }, (_, i) => tab(i, `https://a.example/${i}`)),
        events: Array.from({ length: 100 }, () => event(1, "https://a.example/1")),
      }),
    );
    expect(res).toMatchObject({ status: 200, json: { accepted: 100 } });
  });

  it("answers 413 for a body over 1 MB", async () => {
    const big = batch({ tabs: [tab(1, "https://a.example/", { snippet: "x".repeat(1_100_000) })] });
    expect((await ingest(ALICE, big)).status).toBe(413);
  });

  it("answers 400 for text that is not JSON", async () => {
    const res = await read(ingestPost(new Request("http://localhost/api/ingest/tabs", { method: "POST", headers: { authorization: `Bearer ${ALICE}` }, body: "{oops" })));
    expect(res.status).toBe(400);
  });

  it("truncates a snippet that is too long instead of rejecting the tab", async () => {
    await ingest(ALICE, batch({ tabs: [tab(1, "https://a.example/", { snippet: "y".repeat(5000) })] }));
    expect((await tabs(ALICE))[0].snippet).toHaveLength(2000);
  });
});

describe("the ingest route is separate from pairing", () => {
  it("uses ids the client generated, so an event's id survives a round trip", async () => {
    const e = event(1, "https://a.example/", "opened", { id: uuid() });
    await ingest(ALICE, batch({ events: [e] }));
    expect((await events(ALICE))[0].id).toBe(e.id);
  });
});
