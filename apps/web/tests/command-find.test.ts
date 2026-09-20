import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH as workspacePatch } from "@/app/api/workspaces/[id]/route";
import { query } from "@/src/db";
import * as m from "@/src/command/messages";
import { ans, dataOf, dbSnapshot, ctxHome, installFakeCommandModel, listTabs, makeWorkspace, person, putTabsIn, restoreCommandModel, say, seedTabs, tabIds, wsId } from "./command-helpers";
import { read, req, reset } from "./helpers";

const ALICE = "alice-device-token-0001";
const BOB = "bob-device-token-000002";

beforeEach(async () => {
  await reset();
  await person(ALICE);
  await person(BOB);
});
afterEach(() => {
  restoreCommandModel();
  vi.unstubAllGlobals();
});

const TRIP = [
  { url: "https://airline.example/booking/osaka", title: "Flight booking: Osaka KIX", snippet: "Confirmation for flight NH 6, departing 9 October" },
  { url: "https://hotel.example/kyoto-ryokan", title: "Ryokan Kagaya, Kyoto", snippet: "Traditional inn with onsen and kaiseki dinner" },
  { url: "https://rail.example/jr-pass", title: "Japan Rail Pass prices", snippet: "7, 14 and 21 day passes" },
];
const OTHER = [
  { url: "https://cook.example/ramen", title: "Best ramen recipe", snippet: "Tonkotsu broth in four hours" },
  { url: "https://cook.example/gyoza", title: "Pan-fried gyoza", snippet: "Pleated dumplings" },
  { url: "https://news.example/story", title: "Local news", snippet: "Council votes" },
];

describe("find tabs and workspaces by describing them", () => {
  it("returns the best matches first, each with its workspace (Other for none), and changes nothing", async () => {
    const trip = await makeWorkspace(ALICE, "Trip planning");
    await putTabsIn(ALICE, trip.id, TRIP);
    await seedTabs(ALICE, OTHER);
    const fake = installFakeCommandModel((input) => ans("find", { tabs: [...tabIds(input, "flight booking"), ...tabIds(input, "ramen")] }));
    const before = await dbSnapshot();
    const reply = await say(ALICE, "find my flight tab");
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ kind: "found", understood: "Looking for your tabs matching that.", more: 0, cutNote: null });
    expect(reply.json.tabs.map((t: { tab: { title: string }; workspaceName: string }) => [t.tab.title, t.workspaceName])).toEqual([
      ["Flight booking: Osaka KIX", "Trip planning"], // best first, in the model's order
      ["Best ramen recipe", "Other"], // a tab in Other is labelled Other
    ]);
    const first = reply.json.tabs[0].tab;
    expect(first).toMatchObject({ url: "https://airline.example/booking/osaka", workspaceId: trip.id, placementSource: "user" }); // a full TabRef, so the client can open it
    expect(first.chromeTabId).not.toBeNull();
    expect(fake.calls).toHaveLength(1);
    expect(await dbSnapshot()).toBe(before);
  });

  it("finds a workspace by description: its card can be shown, with how many tabs it has", async () => {
    const cooking = await makeWorkspace(ALICE, "Ramen and dumplings");
    await putTabsIn(ALICE, cooking.id, OTHER.slice(0, 2));
    await makeWorkspace(ALICE, "Empty one");
    installFakeCommandModel((input) => ans("find", { workspaces: [wsId(input, "ramen and dumplings")] }));
    const reply = await say(ALICE, "which workspace has the ramen recipes");
    expect(reply.json.kind).toBe("found");
    expect(reply.json.tabs).toEqual([]);
    expect(reply.json.workspaces).toEqual([{ workspace: expect.objectContaining({ id: cooking.id, name: "Ramen and dumplings", status: "active" }), tabCount: 2 }]);
  });

  it("puts the intended tab among the first three for each of several descriptions", async () => {
    await seedTabs(ALICE, [...TRIP, ...OTHER]);
    const wanted: [string, string][] = [["my flight tab", "flight booking"], ["the inn with the onsen", "ryokan"], ["train pass prices", "rail pass"], ["that broth recipe", "ramen"]];
    for (const [description, fragment] of wanted) {
      installFakeCommandModel((input) => ans("find", { tabs: tabIds(input, fragment) }));
      const reply = await say(ALICE, `find ${description}`);
      expect(reply.json.tabs[0].tab.title.toLowerCase(), description).toContain(fragment.split(" ")[0]);
    }
  });

  it("shows at most 8 tabs and says how many more the model ranked", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ url: `https://many.example/${i}`, title: `Many ${i}` }));
    await seedTabs(ALICE, many);
    installFakeCommandModel((input) => ans("find", { tabs: tabIds(input, "many") }));
    const reply = await say(ALICE, "find the many tabs");
    expect(reply.json.tabs).toHaveLength(8);
    expect(reply.json.more).toBe(4);
  });

  it("drops ids the server never sent, and says nothing matched when nothing valid is left", async () => {
    await seedTabs(ALICE, TRIP);
    installFakeCommandModel(ans("find", { tabs: ["t99", crypto.randomUUID()], workspaces: ["w9"] }));
    expect((await say(ALICE, "find my passport")).json).toEqual({ kind: "say", message: m.FIND_NOTHING, help: null });
    installFakeCommandModel(ans("find"));
    expect((await say(ALICE, "find my passport")).json.kind).toBe("say");
  });

  it("does not search an archived workspace: its tabs are not even sent to the model, and never returned", async () => {
    const retired = await makeWorkspace(ALICE, "Retired trip");
    const [tab] = await putTabsIn(ALICE, retired.id, [{ url: "https://old.example/ticket", title: "OLD-SECRET-TICKET" }]);
    await seedTabs(ALICE, OTHER);
    await read(workspacePatch(req("PATCH", `/api/workspaces/${retired.id}`, ALICE, { status: "archived" }), { params: Promise.resolve({ id: retired.id }) }));
    const fake = installFakeCommandModel((input) => ans("find", { tabs: tabIds(input, "ramen") }));
    const reply = await say(ALICE, "find my ticket");
    expect(fake.calls[0].prompt).not.toContain("OLD-SECRET-TICKET");
    expect(fake.calls[0].prompt).not.toContain("Retired trip");
    expect(JSON.stringify(reply.json)).not.toContain("OLD-SECRET");
    expect(tab.id).toBeTruthy();
  });

  it("also drops a tab whose workspace was archived after the model was shown it", async () => {
    const trip = await makeWorkspace(ALICE, "Trip planning");
    await putTabsIn(ALICE, trip.id, TRIP);
    installFakeCommandModel(async (input) => {
      await read(workspacePatch(req("PATCH", `/api/workspaces/${trip.id}`, ALICE, { status: "archived" }), { params: Promise.resolve({ id: trip.id }) })); // archived while the model thinks
      return ans("find", { tabs: tabIds(input, "flight booking"), workspaces: [wsId(input, "trip planning")] });
    });
    const reply = await say(ALICE, "find my flight tab");
    expect(reply.json).toEqual({ kind: "say", message: m.FIND_NOTHING, help: null });
  });

  it("fetches no page and changes nothing: with the network unavailable it still works", async () => {
    await seedTabs(ALICE, [...TRIP, ...OTHER]);
    const fetchSpy = vi.fn(() => {
      throw new Error("the network must not be used");
    });
    vi.stubGlobal("fetch", fetchSpy);
    installFakeCommandModel((input) => ans("find", { tabs: tabIds(input, "flight") }));
    const before = await dbSnapshot();
    expect((await say(ALICE, "find my flight tab")).json.kind).toBe("found");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await dbSnapshot()).toBe(before);
  });

  it("matches on the titles, addresses, and short excerpts it keeps: the excerpt is sent, cut, and nothing more", async () => {
    await seedTabs(ALICE, [{ url: "https://airline.example/booking/osaka?token=SECRET#frag", title: "Flight", snippet: "S".repeat(500) }]);
    const fake = installFakeCommandModel(ans("find"));
    await say(ALICE, "find my flight");
    const [tab] = dataOf(fake.calls[0]).tabs;
    expect(tab.url).toBe("https://airline.example/booking/osaka"); // no query string, no fragment
    expect(tab.excerpt).toHaveLength(100);
    expect(fake.calls[0].prompt).not.toContain("SECRET");
  });

  it("a question about what is inside a page offers to find the tab instead, and answers nothing about the page", async () => {
    await seedTabs(ALICE, TRIP);
    installFakeCommandModel(ans("unsupported", { reason: "page_content" }));
    const reply = await say(ALICE, "what did the ryokan page say about prices?");
    expect(reply.json).toEqual({
      kind: "ask",
      question: m.PAGE_CONTENT_QUESTION,
      choices: [{ label: m.FIND_THE_TAB, step: { kind: "submit", text: "find the tab: what did the ryokan page say about prices?" } }],
    });
    expect(JSON.stringify(reply.json)).not.toContain("onsen"); // nothing from a page or an excerpt
  });

  it("the find-the-tab button is cut to the command limit", async () => {
    installFakeCommandModel(ans("unsupported", { reason: "page_content" }));
    const reply = await say(ALICE, "w".repeat(300));
    expect(reply.json.choices[0].step.text).toHaveLength(300);
    expect(reply.json.choices[0].step.text.startsWith("find the tab: ")).toBe(true);
  });

  it("says it looked at only the most recent tabs when there were more than it could send, and only then", async () => {
    const lots = Array.from({ length: 160 }, (_, i) => ({ url: `https://lots.example/${i}`, title: `Lots ${i}` }));
    await seedTabs(ALICE, lots);
    const fake = installFakeCommandModel((input) => ans("find", { tabs: tabIds(input, "lots 3") }));
    const reply = await say(ALICE, "find lots 3");
    expect(dataOf(fake.calls[0]).tabs).toHaveLength(150);
    expect(dataOf(fake.calls[0]).tabsNote).toBe("the 150 most recent of 160");
    expect(reply.json.cutNote).toBe("Looked at your 150 most recent of 160 tabs.");
    // Fewer than 150: no note.
    await reset();
    await person(ALICE);
    await seedTabs(ALICE, lots.slice(0, 10));
    installFakeCommandModel((input) => ans("find", { tabs: tabIds(input, "lots 3") }));
    expect((await say(ALICE, "find lots 3")).json.cutNote).toBeNull();
  });

  it("never shows another person's tabs or workspaces", async () => {
    const bobs = await makeWorkspace(BOB, "BOBS-SECRET-WS");
    await putTabsIn(BOB, bobs.id, [{ url: "https://bob.example/flight", title: "BOBS-SECRET-FLIGHT" }]);
    await seedTabs(ALICE, TRIP);
    const fake = installFakeCommandModel((input) => ans("find", { tabs: [...tabIds(input, "flight"), "t99"], workspaces: ["w99"] }));
    const reply = await say(ALICE, "find my flight tab", ctxHome());
    expect(fake.calls[0].prompt).not.toContain("BOBS-SECRET");
    expect(JSON.stringify(reply.json)).not.toContain("BOBS-SECRET");
    expect((await listTabs(BOB))).toHaveLength(1);
    expect((await query("SELECT count(*) AS n FROM tab_refs")).rows[0].n).toBeDefined();
  });
});
