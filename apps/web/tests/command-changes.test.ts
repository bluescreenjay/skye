import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PATCH as tabRefPatch } from "@/app/api/tab-refs/[id]/route";
import { PATCH as workspacePatch } from "@/app/api/workspaces/[id]/route";
import { query } from "@/src/db";
import * as m from "@/src/command/messages";
import { addMessageAt, addPlanItem, userIdOf } from "./chat-helpers";
import { installFakeAgentModel, restoreAgentModel, runAndWait } from "./agents-helpers";
import { group, idsFor, installFakeModel, restoreModel } from "./cluster-helpers";
import {
  ans,
  apply,
  ctxHome,
  ctxPage,
  dbSnapshot,
  installFakeCommandModel,
  listTabs,
  makeWorkspace,
  person,
  putTabsIn,
  restoreCommandModel,
  say,
  seedTabs,
  undoState,
  wsId,
} from "./command-helpers";
import { read, req, reset } from "./helpers";

const ALICE = "alice-device-token-0001";
const BOB = "bob-device-token-000002";

const TRIP = [
  { url: "https://travel.example/flights", title: "Flights to Osaka" },
  { url: "https://travel.example/hotel", title: "Hotel in Kyoto" },
  { url: "https://travel.example/rail", title: "Japan Rail Pass" },
];

beforeEach(async () => {
  await reset();
  await person(ALICE);
  await person(BOB);
});
afterEach(async () => {
  restoreCommandModel();
  restoreModel();
  await restoreAgentModel();
});

const patchTab = (id: string, body: Record<string, unknown>) =>
  read(tabRefPatch(req("PATCH", `/api/tab-refs/${id}`, ALICE, body), { params: Promise.resolve({ id }) }));
const patchWorkspace = (id: string, body: Record<string, unknown>) =>
  read(workspacePatch(req("PATCH", `/api/workspaces/${id}`, ALICE, body), { params: Promise.resolve({ id }) }));
const workspacesNamed = async (name: string) => (await query<{ id: string; status: string }>("SELECT id, status FROM workspaces WHERE name = $1", [name])).rows;

describe("create a workspace", () => {
  it("makes a workspace with exactly the given name from the tabs in Other, with no confirmation, and can be undone", async () => {
    await seedTabs(ALICE, TRIP);
    installFakeCommandModel(ans("create", { scope: "these_tabs", name: "Kyoto trip" }));
    const before = await dbSnapshot();
    const reply = await say(ALICE, "create a workspace called Kyoto trip");
    expect(reply.json).toMatchObject({ kind: "action", understood: "Creating Kyoto trip with 3 tabs.", action: { type: "create", name: "Kyoto trip" } });
    expect(reply.json.action.tabRefIds).toHaveLength(3);
    expect(await dbSnapshot()).toBe(before); // interpreting changed nothing

    const done = await apply(ALICE, reply.json.action);
    expect(done.json).toMatchObject({ status: "done", message: "Created Kyoto trip with 3 tabs.", next: null });
    expect(done.json.counts).toMatchObject({ moved: 3, workspacesCreated: 1 });
    expect(done.json.workspace.name).toBe("Kyoto trip"); // stored exactly as given
    expect(done.json.undo).toMatchObject({ kind: "create", summary: "created Kyoto trip with 3 tabs" });

    const tabs = await listTabs(ALICE);
    expect(tabs.every((t) => t.workspaceId === done.json.workspace.id && t.placementSource === "user")).toBe(true);
    const events = await query("SELECT 1 FROM tab_events WHERE event_type = 'reassigned' AND workspace_id = $1", [done.json.workspace.id]);
    expect(events.rows).toHaveLength(3);
    const row = (await query<{ payload: { createdWorkspaceId: string; moves: unknown[] } }>("SELECT payload FROM command_undo")).rows[0];
    expect(row.payload.createdWorkspaceId).toBe(done.json.workspace.id);
    expect(row.payload.moves).toHaveLength(3);
  });

  it("uses a name drawn from the tabs when none was given, and refuses a generic name", async () => {
    await seedTabs(ALICE, TRIP);
    installFakeCommandModel(ans("create", { scope: "these_tabs", name: "Japan planning" }));
    expect((await say(ALICE, "create a workspace for these tabs")).json).toMatchObject({ kind: "action", action: { type: "create", name: "Japan planning" } });
    installFakeCommandModel(ans("create", { scope: "these_tabs", name: "Group 3" }));
    expect((await say(ALICE, "create a workspace for these tabs")).json).toEqual({ kind: "say", message: m.NO_NAME, help: null });
  });

  it("says there are no tabs to put in it when Other is empty", async () => {
    installFakeCommandModel(ans("create", { scope: "these_tabs", name: "Kyoto trip" }));
    expect((await say(ALICE, "create a workspace for these tabs")).json).toEqual({ kind: "say", message: m.NO_TABS_FOR_CREATE, help: null });
  });

  it("on a page takes only this window's tabs that are in no workspace", async () => {
    const tabs = await seedTabs(ALICE, [...TRIP, { url: "https://other.example/elsewhere", title: "Another window" }]);
    const inWindow = tabs.filter((t) => t.url.includes("travel.example"));
    const placed = await makeWorkspace(ALICE, "Already placed");
    await patchTab(inWindow[2].id, { workspaceId: placed.id }); // in a workspace already: not "loose"
    const active = { chromeTabId: inWindow[0].chromeTabId!, url: inWindow[0].url };
    installFakeCommandModel(ans("create", { scope: "these_tabs", name: "This window" }));
    const reply = await say(ALICE, "create a workspace for these tabs", ctxPage(active, { windowTabIds: inWindow.map((t) => t.chromeTabId!) }));
    expect(reply.json.action.tabRefIds.sort()).toEqual([inWindow[0].id, inWindow[1].id].sort());
  });

  it("confirms only when a tab in the set was placed by the person (even in Other), and moves nothing before that", async () => {
    const tabs = await seedTabs(ALICE, TRIP);
    await patchTab(tabs[0].id, { workspaceId: null }); // deliberately kept in Other: the person's own placement
    installFakeCommandModel(ans("create", { scope: "these_tabs", name: "Kyoto trip" }));
    const action = (await say(ALICE, "create a workspace for these tabs")).json.action;

    const before = await dbSnapshot();
    const asked = await apply(ALICE, action, false);
    expect(asked.json.status).toBe("needs_confirmation");
    expect(asked.json.preview.title).toBe("Create “Kyoto trip” with 3 tabs");
    expect(asked.json.preview.lines.map((l: { title: string }) => l.title).sort()).toEqual(["Flights to Osaka", "Hotel in Kyoto", "Japan Rail Pass"]);
    expect(asked.json.preview.lines.every((l: { from: string; to: string }) => l.from === "Other" && l.to === "Kyoto trip")).toBe(true);
    expect(await dbSnapshot()).toBe(before);

    expect((await apply(ALICE, action, true)).json.status).toBe("done");
    expect((await listTabs(ALICE)).every((t) => t.workspaceId !== null)).toBe(true);
  });

  it("a name already in use (any case) creates nothing and offers to add the tabs to the existing workspace", async () => {
    await seedTabs(ALICE, TRIP);
    const existing = await makeWorkspace(ALICE, "Kyoto trip");
    installFakeCommandModel(ans("create", { scope: "these_tabs", name: "kyoto TRIP" }));
    const before = await dbSnapshot();
    const reply = await say(ALICE, "create a workspace called kyoto TRIP");
    expect(reply.json.kind).toBe("ask");
    expect(reply.json.question).toBe(m.NAME_EXISTS_QUESTION);
    expect(reply.json.choices).toHaveLength(1);
    expect(reply.json.choices[0].step).toMatchObject({ kind: "action", action: { type: "move", toWorkspaceId: existing.id } });
    expect(await dbSnapshot()).toBe(before);
    // Applying a create with that name anyway is refused, and nothing is made.
    const action = { type: "create", name: "  KYOTO trip ", tabRefIds: (await listTabs(ALICE)).map((t) => t.id) };
    expect((await apply(ALICE, action)).json).toEqual({ status: "refused", code: "name_taken", message: m.REFUSAL.name_taken });
    expect(await workspacesNamed("Kyoto trip")).toHaveLength(1);
  });

  it("refuses Other and an 81-character name", async () => {
    const tabs = await seedTabs(ALICE, TRIP);
    const ids = tabs.map((t) => t.id);
    expect((await apply(ALICE, { type: "create", name: "Other", tabRefIds: ids })).json).toEqual({ status: "refused", code: "reserved_name", message: m.REFUSAL.reserved_name });
    expect((await apply(ALICE, { type: "create", name: " oTHER ", tabRefIds: ids })).json.code).toBe("reserved_name");
    const long = await apply(ALICE, { type: "create", name: "x".repeat(81), tabRefIds: ids });
    expect(long.status).toBe(400);
    expect(long.json.code).toBe("bad_action");
  });

  it("writes a correction for a tab the AI had placed, without asking to confirm", async () => {
    await seedTabs(ALICE, [...TRIP, { url: "https://cook.example/ramen", title: "Ramen" }, { url: "https://cook.example/gyoza", title: "Gyoza" }]);
    installFakeModel((input) => [group("Cooking", idsFor(input, "cook.example"), 0.9)]);
    await apply(ALICE, { type: "organize" });
    const aiPlaced = (await listTabs(ALICE)).filter((t) => t.placementSource === "ai");
    expect(aiPlaced).toHaveLength(2);
    const result = await apply(ALICE, { type: "create", name: "Food", tabRefIds: aiPlaced.map((t) => t.id) });
    expect(result.json.status).toBe("done"); // ai-placed is not person-placed: no confirmation
    const corrections = await query("SELECT from_workspace_id, to_workspace_id FROM corrections WHERE tab_ref_id = ANY($1::uuid[])", [aiPlaced.map((t) => t.id)]);
    expect(corrections.rows).toHaveLength(2);
    expect(corrections.rows.every((r) => r.to_workspace_id === result.json.workspace.id)).toBe(true);
  });

  it("refuses more than 200 tabs before writing anything", async () => {
    const ids = Array.from({ length: 201 }, () => crypto.randomUUID());
    const before = await dbSnapshot();
    expect((await apply(ALICE, { type: "create", name: "Big", tabRefIds: ids })).json).toEqual({ status: "refused", code: "too_many", message: m.REFUSAL.too_many });
    expect(await dbSnapshot()).toBe(before);
  });

  it("refuses when none of the tabs exist any more, and leaves no empty workspace behind", async () => {
    const before = await dbSnapshot();
    const result = await apply(ALICE, { type: "create", name: "Ghosts", tabRefIds: [crypto.randomUUID(), crypto.randomUUID()] });
    expect(result.json).toEqual({ status: "refused", code: "not_found", message: m.REFUSAL.not_found });
    expect(await dbSnapshot()).toBe(before);
  });

  it("never touches another person's tabs", async () => {
    const bobs = await seedTabs(BOB, TRIP);
    const before = await dbSnapshot();
    const result = await apply(ALICE, { type: "create", name: "Stolen", tabRefIds: bobs.map((t) => t.id) });
    expect(result.json.status).toBe("refused");
    expect(await dbSnapshot()).toBe(before);
  });

  it("Undo puts the tabs back to their old placement and archives the new workspace while it is empty and untouched", async () => {
    const tabs = await seedTabs(ALICE, TRIP);
    const done = await apply(ALICE, { type: "create", name: "Kyoto trip", tabRefIds: tabs.map((t) => t.id) });
    const undone = await apply(ALICE, { type: "undo" });
    expect(undone.json).toMatchObject({ status: "done", message: "Undone. Put 3 tabs back." });
    const after = await listTabs(ALICE);
    expect(after.every((t) => t.workspaceId === null && t.placementSource === null)).toBe(true);
    expect((await workspacesNamed("Kyoto trip"))[0].status).toBe("archived");
    expect((await undoState(ALICE)).json).toEqual({ undo: null });
    expect(done.json.workspace.id).toBe((await workspacesNamed("Kyoto trip"))[0].id);
  });

  it("Undo keeps a new workspace the person has since renamed, and says so", async () => {
    const tabs = await seedTabs(ALICE, TRIP);
    const done = await apply(ALICE, { type: "create", name: "Kyoto trip", tabRefIds: tabs.map((t) => t.id) });
    await patchWorkspace(done.json.workspace.id, { name: "Japan 2026" });
    const undone = await apply(ALICE, { type: "undo" });
    expect(undone.json.message).toBe(`Undone. Put 3 tabs back. ${m.UNDO_WORKSPACE_KEPT}`);
    const [row] = (await query<{ status: string }>("SELECT status FROM workspaces WHERE id = $1", [done.json.workspace.id])).rows;
    expect(row.status).toBe("active"); // not archived: the person made it their own
  });

  it("Undo does not move a tab the person has moved since", async () => {
    const tabs = await seedTabs(ALICE, TRIP);
    const other = await makeWorkspace(ALICE, "Elsewhere");
    await apply(ALICE, { type: "create", name: "Kyoto trip", tabRefIds: tabs.map((t) => t.id) });
    await patchTab(tabs[0].id, { workspaceId: other.id });
    const undone = await apply(ALICE, { type: "undo" });
    expect(undone.json.message).toContain("Put 2 tabs back. 1 tab kept where you put it.");
    expect((await listTabs(ALICE)).find((t) => t.id === tabs[0].id)!.workspaceId).toBe(other.id);
  });

  it("a second changing command replaces the undo row: only the most recent change can be undone", async () => {
    const tabs = await seedTabs(ALICE, [...TRIP, { url: "https://x.example/1", title: "X1" }]);
    await apply(ALICE, { type: "create", name: "First", tabRefIds: tabs.slice(0, 2).map((t) => t.id) });
    await apply(ALICE, { type: "create", name: "Second", tabRefIds: tabs.slice(2).map((t) => t.id) });
    expect((await undoState(ALICE)).json.undo.summary).toBe("created Second with 2 tabs");
    await apply(ALICE, { type: "undo" });
    // The first change stands: it can no longer be undone.
    expect((await apply(ALICE, { type: "undo" })).json.status).toBe("nothing_to_do");
    expect((await listTabs(ALICE)).filter((t) => t.workspaceId !== null)).toHaveLength(2);
  });

  it("makes no AI request when applying", async () => {
    const tabs = await seedTabs(ALICE, TRIP);
    const fake = installFakeCommandModel();
    await apply(ALICE, { type: "create", name: "Kyoto trip", tabRefIds: tabs.map((t) => t.id) });
    expect(fake.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// User Story 4: put related tabs together.
// ---------------------------------------------------------------------------------------------------
const SHOP = [
  { url: "https://shop.example/camera", title: "Nikon Z6 III review" },
  { url: "https://shop.example/tripod", title: "Best travel tripods" },
  { url: "https://shop.example/lens", title: "50mm lens deals" },
];
const NOISE = [{ url: "https://news.example/story", title: "Local news" }];

describe("put described tabs together", () => {
  it("shows the matching tabs by title and moves nothing until Confirm, then puts them in one workspace", async () => {
    await seedTabs(ALICE, [...SHOP, ...NOISE]);
    installFakeCommandModel((input) => ans("group", { tabs: tabIdsOf(input, "shop.example"), name: "Shopping" }));
    const before = await dbSnapshot();
    const reply = await say(ALICE, "put my shopping tabs together");
    expect(reply.json).toMatchObject({ kind: "action", understood: "Putting 3 tabs together in Shopping.", action: { type: "group", target: { newName: "Shopping" } } });
    expect(await dbSnapshot()).toBe(before); // interpreting changed nothing

    const action = reply.json.action;
    const asked = await apply(ALICE, action, false);
    expect(asked.json.status).toBe("needs_confirmation");
    expect(asked.json.preview.title).toBe("Put 3 tabs together in Shopping");
    expect(asked.json.preview.lines.map((l: { title: string }) => l.title).sort()).toEqual(["50mm lens deals", "Best travel tripods", "Nikon Z6 III review"]);
    expect(await dbSnapshot()).toBe(before); // asking changed nothing

    const done = await apply(ALICE, action, true);
    expect(done.json).toMatchObject({ status: "done", message: "Put 3 tabs together in Shopping.", counts: { moved: 3, workspacesCreated: 1 } });
    expect(done.json.undo).toMatchObject({ kind: "group" });
    const tabs = await listTabs(ALICE);
    const shopping = tabs.filter((t) => t.url.includes("shop.example"));
    expect(new Set(shopping.map((t) => t.workspaceId)).size).toBe(1);
    expect(shopping.every((t) => t.workspaceId !== null && t.placementSource === "user")).toBe(true);
    expect(tabs.find((t) => t.url.includes("news.example"))!.workspaceId).toBeNull(); // the unrelated tab was not touched

    const undone = await apply(ALICE, { type: "undo" });
    expect(undone.json.status).toBe("done");
    expect((await listTabs(ALICE)).every((t) => t.workspaceId === null && t.placementSource === null)).toBe(true);
  });

  it("Cancel (sending nothing) leaves the database exactly as it was", async () => {
    await seedTabs(ALICE, SHOP);
    installFakeCommandModel((input) => ans("group", { tabs: tabIdsOf(input, "shop.example"), name: "Shopping" }));
    const action = (await say(ALICE, "put my shopping tabs together")).json.action;
    const before = await dbSnapshot();
    await apply(ALICE, action, false); // the preview, then the person cancels: no further request
    expect(await dbSnapshot()).toBe(before);
  });

  it("goes into an existing workspace when the interpreter matched one by name or by destination", async () => {
    await seedTabs(ALICE, SHOP);
    const existing = await makeWorkspace(ALICE, "Shopping");
    installFakeCommandModel((input) => ans("group", { tabs: tabIdsOf(input, "shop.example"), name: "shopping" }));
    const byName = await say(ALICE, "put my shopping tabs together");
    expect(byName.json.action.target).toEqual({ workspaceId: existing.id });
    installFakeCommandModel((input) => ans("group", { tabs: tabIdsOf(input, "shop.example"), destination: [wsId(input, "shopping")], destinationNamed: true }));
    expect((await say(ALICE, "put my shopping tabs into shopping")).json.action.target).toEqual({ workspaceId: existing.id });
    const done = await apply(ALICE, byName.json.action, true);
    expect(done.json).toMatchObject({ status: "done", counts: { workspacesCreated: 0 } });
    expect((await workspacesNamed("Shopping"))).toHaveLength(1); // no near-duplicate workspace
  });

  it("applying a group by a NAME that already exists joins that workspace instead of making another", async () => {
    const tabs = await seedTabs(ALICE, SHOP);
    const existing = await makeWorkspace(ALICE, "Shopping");
    const done = await apply(ALICE, { type: "group", tabRefIds: tabs.map((t) => t.id), target: { newName: "  SHOPPING " } }, true);
    expect(done.json.status).toBe("done");
    expect((await listTabs(ALICE)).every((t) => t.workspaceId === existing.id)).toBe(true);
  });

  it("includes a tab the person hand-placed elsewhere in the preview, and moves it only on Confirm", async () => {
    const tabs = await seedTabs(ALICE, SHOP);
    const errands = await makeWorkspace(ALICE, "Errands");
    await patchTab(tabs[0].id, { workspaceId: errands.id }); // the person's own placement
    installFakeCommandModel((input) => ans("group", { tabs: tabIdsOf(input, "shop.example"), name: "Shopping" }));
    const action = (await say(ALICE, "put my shopping tabs together")).json.action;
    expect(action.tabRefIds).toContain(tabs[0].id);

    const asked = await apply(ALICE, action, false);
    const line = asked.json.preview.lines.find((l: { tabRefId: string }) => l.tabRefId === tabs[0].id);
    expect(line).toMatchObject({ from: "Errands", to: "Shopping" });
    expect((await listTabs(ALICE)).find((t) => t.id === tabs[0].id)!.workspaceId).toBe(errands.id); // not moved yet

    await apply(ALICE, action, true);
    expect((await listTabs(ALICE)).find((t) => t.id === tabs[0].id)!.workspaceId).not.toBe(errands.id);
  });

  it("a general organize NEVER moves a hand-placed tab", async () => {
    const tabs = await seedTabs(ALICE, [...SHOP, { url: "https://loose.example/a", title: "Loose A" }, { url: "https://loose.example/b", title: "Loose B" }]);
    const errands = await makeWorkspace(ALICE, "Errands");
    await patchTab(tabs[0].id, { workspaceId: errands.id });
    const cluster = installFakeModel((input) => [group("Loose", idsFor(input, "loose.example"), 0.9)]);
    await apply(ALICE, { type: "organize" });
    expect(cluster.calls[0].tabs.map((t) => t.url)).not.toContain(tabs[0].url); // it was never even offered to the model
    expect((await listTabs(ALICE)).find((t) => t.id === tabs[0].id)).toMatchObject({ workspaceId: errands.id, placementSource: "user" });
  });

  it("says nothing matched, and changes nothing, with fewer than two matching tabs", async () => {
    await seedTabs(ALICE, [...SHOP, ...NOISE]);
    const before = await dbSnapshot();
    installFakeCommandModel((input) => ans("group", { tabs: tabIdsOf(input, "camera"), name: "Shopping" }));
    expect((await say(ALICE, "put my camera tabs together")).json).toEqual({ kind: "say", message: m.NO_MATCHING_TABS, help: null });
    installFakeCommandModel(ans("group", { tabs: [], name: "Shopping" }));
    expect((await say(ALICE, "put my boat tabs together")).json.kind).toBe("say");
    expect(await dbSnapshot()).toBe(before);
  });

  it("asks which workspace when the destination matches two, with a resolved group action per button", async () => {
    await seedTabs(ALICE, SHOP);
    const a = await makeWorkspace(ALICE, "Gear 2025");
    const b = await makeWorkspace(ALICE, "Gear 2026");
    installFakeCommandModel((input) => ans("group", { tabs: tabIdsOf(input, "shop.example"), destination: [wsId(input, "gear 2025"), wsId(input, "gear 2026")], destinationNamed: true }));
    const reply = await say(ALICE, "put my shopping tabs in gear");
    expect(reply.json.kind).toBe("ask");
    expect(reply.json.choices.map((c: { step: { action: { target: unknown } } }) => c.step.action.target)).toEqual([{ workspaceId: a.id }, { workspaceId: b.id }]);
  });

  it("says so when the named destination does not exist, and when there is no name at all", async () => {
    await seedTabs(ALICE, SHOP);
    installFakeCommandModel((input) => ans("group", { tabs: tabIdsOf(input, "shop.example"), destination: ["w9"], destinationNamed: true }));
    expect((await say(ALICE, "put my shopping tabs into errands")).json.message).toContain("I couldn't find a workspace like that.");
    installFakeCommandModel((input) => ans("group", { tabs: tabIdsOf(input, "shop.example"), name: null }));
    expect((await say(ALICE, "put my shopping tabs together")).json).toEqual({ kind: "say", message: m.NO_NAME, help: null });
  });

  it("shows at most 20 lines and says how many more", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ url: `https://many.example/${i}`, title: `Page ${i}` }));
    const tabs = await seedTabs(ALICE, many);
    const asked = await apply(ALICE, { type: "group", tabRefIds: tabs.map((t) => t.id), target: { newName: "Many" } }, false);
    expect(asked.json.preview.lines).toHaveLength(20);
    expect(asked.json.preview.hiddenCount).toBe(5);
  });

  it("only moves the tabs that still exist, and says how many did not", async () => {
    const tabs = await seedTabs(ALICE, SHOP);
    const ids = [...tabs.map((t) => t.id), crypto.randomUUID()];
    const done = await apply(ALICE, { type: "group", tabRefIds: ids, target: { newName: "Shopping" } }, true);
    expect(done.json).toMatchObject({ status: "done", message: "Put 3 tabs together in Shopping. 1 no longer exists.", counts: { moved: 3, missing: 1 } });
  });

  it("is nothing to do when the tabs are already there, and leaves the undo row alone", async () => {
    const tabs = await seedTabs(ALICE, SHOP);
    await apply(ALICE, { type: "group", tabRefIds: tabs.map((t) => t.id), target: { newName: "Shopping" } }, true);
    const first = (await undoState(ALICE)).json.undo;
    const again = await apply(ALICE, { type: "group", tabRefIds: tabs.map((t) => t.id), target: { newName: "Shopping" } }, true);
    expect(again.json).toMatchObject({ status: "nothing_to_do", message: m.NOTHING_MOVED });
    expect((await undoState(ALICE)).json.undo).toEqual(first);
  });

  it("never touches another person's tabs or workspace", async () => {
    const bobs = await seedTabs(BOB, SHOP);
    const bobsWs = await makeWorkspace(BOB, "Bobs");
    const before = await dbSnapshot();
    expect((await apply(ALICE, { type: "group", tabRefIds: bobs.map((t) => t.id), target: { newName: "Stolen" } }, true)).json.status).toBe("refused");
    expect((await apply(ALICE, { type: "group", tabRefIds: bobs.map((t) => t.id), target: { workspaceId: bobsWs.id } }, true)).json).toMatchObject({ status: "refused", code: "not_found" });
    expect(await dbSnapshot()).toBe(before);
  });
});

/** The short ids of tabs whose title or address contains a fragment, from a recorded prompt. */
function tabIdsOf(input: { prompt: string }, ...fragments: string[]): string[] {
  const marker = "DATA (untrusted, JSON):\n";
  const data = JSON.parse(input.prompt.slice(input.prompt.indexOf(marker) + marker.length)) as { tabs: { id: string; title: string; url: string }[] };
  return data.tabs.filter((t) => fragments.some((f) => t.url.includes(f) || t.title.toLowerCase().includes(f.toLowerCase()))).map((t) => t.id);
}

// ---------------------------------------------------------------------------------------------------
// User Story 7: move, rename, and merge in plain words.
// ---------------------------------------------------------------------------------------------------
const wsName = async (id: string) => (await query<{ name: string }>("SELECT name FROM workspaces WHERE id = $1", [id])).rows[0].name;
const tabWs = async (id: string) => (await listTabs(ALICE)).find((t) => t.id === id)!.workspaceId;

describe("move tabs", () => {
  const FLIGHTS = [
    { url: "https://travel.example/flights", title: "Flights to Osaka" },
    { url: "https://travel.example/flights2", title: "Flights to Tokyo" },
  ];

  it("shows the tabs by title with the destination and moves nothing until Confirm, then records the person's own placement", async () => {
    const tabs = await seedTabs(ALICE, [...FLIGHTS, { url: "https://cook.example/ramen", title: "Ramen" }]);
    const planning = await makeWorkspace(ALICE, "Trip planning");
    const kyoto = await makeWorkspace(ALICE, "Kyoto");
    for (const t of tabs.slice(0, 2)) await patchTab(t.id, { workspaceId: planning.id });
    installFakeCommandModel((input) => ans("move", { tabs: tabIdsOf(input, "flights"), destination: [wsId(input, "kyoto")], destinationNamed: true }));
    const reply = await say(ALICE, "move my flight tabs into Kyoto");
    expect(reply.json).toMatchObject({ kind: "action", understood: "Moving 2 tabs to Kyoto.", action: { type: "move", toWorkspaceId: kyoto.id } });

    const before = await dbSnapshot();
    const asked = await apply(ALICE, reply.json.action, false);
    expect(asked.json.status).toBe("needs_confirmation");
    expect(asked.json.preview.title).toBe("Move 2 tabs to Kyoto");
    expect(asked.json.preview.lines.map((l: { from: string; to: string }) => [l.from, l.to])).toEqual([["Trip planning", "Kyoto"], ["Trip planning", "Kyoto"]]);
    expect(await dbSnapshot()).toBe(before);

    const done = await apply(ALICE, reply.json.action, true);
    expect(done.json).toMatchObject({ status: "done", message: "Moved 2 tabs to Kyoto.", counts: { moved: 2 }, undo: { kind: "move" } });
    const after = await listTabs(ALICE);
    expect(after.filter((t) => t.workspaceId === kyoto.id).every((t) => t.placementSource === "user")).toBe(true);
    expect(after.find((t) => t.url.includes("ramen"))!.workspaceId).toBeNull();
  });

  it("leaves tabs already in the destination alone, and says how many", async () => {
    const tabs = await seedTabs(ALICE, FLIGHTS);
    const kyoto = await makeWorkspace(ALICE, "Kyoto");
    await patchTab(tabs[0].id, { workspaceId: kyoto.id });
    const done = await apply(ALICE, { type: "move", tabRefIds: tabs.map((t) => t.id), toWorkspaceId: kyoto.id }, true);
    expect(done.json).toMatchObject({ status: "done", message: "Moved 1 tab to Kyoto. 1 already there.", counts: { moved: 1, alreadyThere: 1 } });
  });

  it("is nothing to do when every tab is already there, and the undo row is left alone", async () => {
    const tabs = await seedTabs(ALICE, FLIGHTS);
    const kyoto = await makeWorkspace(ALICE, "Kyoto");
    await apply(ALICE, { type: "move", tabRefIds: tabs.map((t) => t.id), toWorkspaceId: kyoto.id }, true);
    const first = (await undoState(ALICE)).json.undo;
    expect((await apply(ALICE, { type: "move", tabRefIds: tabs.map((t) => t.id), toWorkspaceId: kyoto.id }, true)).json).toMatchObject({ status: "nothing_to_do", message: m.NOTHING_MOVED });
    expect((await undoState(ALICE)).json.undo).toEqual(first);
  });

  it("'put these back in Other' takes the current workspace's tabs, shows them, and returns them to Other after a confirm", async () => {
    const tabs = await seedTabs(ALICE, FLIGHTS);
    const kyoto = await makeWorkspace(ALICE, "Kyoto");
    for (const t of tabs) await patchTab(t.id, { workspaceId: kyoto.id });
    installFakeCommandModel(ans("move", { toOther: true, scope: "these_tabs" }));
    const reply = await say(ALICE, "put these back in Other", ctxHome({ expandedWorkspaceIds: [kyoto.id] }));
    expect(reply.json).toMatchObject({ kind: "action", understood: "Moving 2 tabs to Other.", action: { type: "move", toWorkspaceId: null } });
    const asked = await apply(ALICE, reply.json.action, false);
    expect(asked.json.preview.lines.every((l: { to: string }) => l.to === "Other")).toBe(true);
    await apply(ALICE, reply.json.action, true);
    // Other is a decision too: recorded as the person's own placement.
    expect((await listTabs(ALICE)).every((t) => t.workspaceId === null && t.placementSource === "user")).toBe(true);
  });

  it("'these tabs' with no current workspace says why", async () => {
    await seedTabs(ALICE, FLIGHTS);
    installFakeCommandModel(ans("move", { toOther: true, scope: "these_tabs" }));
    expect((await say(ALICE, "put these back in Other", ctxHome())).json).toEqual({ kind: "say", message: m.CURRENT_NONE, help: null });
  });

  it("a destination that does not exist is said plainly, and one that is gone by confirm time is refused, with nothing changed", async () => {
    const tabs = await seedTabs(ALICE, FLIGHTS);
    installFakeCommandModel((input) => ans("move", { tabs: tabIdsOf(input, "flights"), destination: ["w9"], destinationNamed: true }));
    expect((await say(ALICE, "move my flight tabs into Atlantis")).json.message).toContain("I couldn't find a workspace like that.");
    const gone = await makeWorkspace(ALICE, "Gone");
    await patchWorkspace(gone.id, { status: "archived" });
    const before = await dbSnapshot();
    expect((await apply(ALICE, { type: "move", tabRefIds: tabs.map((t) => t.id), toWorkspaceId: gone.id }, true)).json).toMatchObject({ status: "refused", code: "not_found" });
    expect(await dbSnapshot()).toBe(before);
  });

  it("asks which when the destination matches two, changing nothing", async () => {
    await seedTabs(ALICE, FLIGHTS);
    const a = await makeWorkspace(ALICE, "Trip 2025");
    const b = await makeWorkspace(ALICE, "Trip 2026");
    installFakeCommandModel((input) => ans("move", { tabs: tabIdsOf(input, "flights"), destination: [wsId(input, "trip 2025"), wsId(input, "trip 2026")], destinationNamed: true }));
    const before = await dbSnapshot();
    const reply = await say(ALICE, "move my flight tabs into trip");
    expect(reply.json.kind).toBe("ask");
    expect(reply.json.choices.map((c: { step: { action: { toWorkspaceId: string } } }) => c.step.action.toWorkspaceId)).toEqual([a.id, b.id]);
    expect(await dbSnapshot()).toBe(before);
  });

  it("only moves the tabs that still exist, and Undo puts back their old placement", async () => {
    const tabs = await seedTabs(ALICE, FLIGHTS);
    const planning = await makeWorkspace(ALICE, "Trip planning");
    const kyoto = await makeWorkspace(ALICE, "Kyoto");
    await patchTab(tabs[0].id, { workspaceId: planning.id });
    const done = await apply(ALICE, { type: "move", tabRefIds: [...tabs.map((t) => t.id), crypto.randomUUID()], toWorkspaceId: kyoto.id }, true);
    expect(done.json.counts).toMatchObject({ moved: 2, missing: 1 });
    await apply(ALICE, { type: "undo" });
    expect(await tabWs(tabs[0].id)).toBe(planning.id); // back where the person had put it
    expect((await listTabs(ALICE)).find((t) => t.id === tabs[0].id)!.placementSource).toBe("user");
    expect(await tabWs(tabs[1].id)).toBeNull();
    expect((await listTabs(ALICE)).find((t) => t.id === tabs[1].id)!.placementSource).toBeNull();
  });
});

describe("rename a workspace", () => {
  it("shows old and new names, changes nothing until Confirm, then the name and updated_at change", async () => {
    const shopping = await makeWorkspace(ALICE, "Shopping");
    installFakeCommandModel((input) => ans("rename", { subject: [wsId(input, "shopping")], subjectNamed: true, name: "Errands" }));
    const reply = await say(ALICE, "rename shopping to Errands");
    expect(reply.json).toMatchObject({ kind: "action", understood: "Renaming Shopping to Errands.", action: { type: "rename", workspaceId: shopping.id, name: "Errands" } });
    const before = await dbSnapshot();
    const asked = await apply(ALICE, reply.json.action, false);
    expect(asked.json.preview.title).toBe("Rename Shopping to Errands");
    expect(asked.json.preview.lines).toEqual([{ tabRefId: null, title: "Workspace name", from: "Shopping", to: "Errands" }]);
    expect(await dbSnapshot()).toBe(before);
    const done = await apply(ALICE, reply.json.action, true);
    expect(done.json).toMatchObject({ status: "done", message: "Renamed Shopping to Errands.", workspace: { id: shopping.id, name: "Errands" }, undo: { kind: "rename", summary: "renamed Shopping to Errands" } });
    expect(await wsName(shopping.id)).toBe("Errands");
    const row = (await query<{ n: boolean }>("SELECT updated_at > created_at AS n FROM workspaces WHERE id = $1", [shopping.id])).rows[0];
    expect(row.n).toBe(true);
  });

  it("'this workspace' is the current one, and with no name given it defaults to it", async () => {
    const shopping = await makeWorkspace(ALICE, "Shopping");
    installFakeCommandModel(ans("rename", { thisWorkspace: true, name: "Errands" }));
    const reply = await say(ALICE, "rename this workspace to Errands", ctxHome({ expandedWorkspaceIds: [shopping.id] }));
    expect(reply.json.action).toEqual({ type: "rename", workspaceId: shopping.id, name: "Errands" });
    installFakeCommandModel(ans("rename", { thisWorkspace: true, name: null }));
    expect((await say(ALICE, "rename this workspace", ctxHome({ expandedWorkspaceIds: [shopping.id] }))).json).toEqual({ kind: "say", message: m.NO_NAME_TO_RENAME, help: null });
  });

  it("refuses a name another workspace has (any case), and Other, changing nothing", async () => {
    const shopping = await makeWorkspace(ALICE, "Shopping");
    await makeWorkspace(ALICE, "Errands");
    const before = await dbSnapshot();
    expect((await apply(ALICE, { type: "rename", workspaceId: shopping.id, name: "  eRRands " }, true)).json).toEqual({ status: "refused", code: "name_taken", message: m.REFUSAL.name_taken });
    expect((await apply(ALICE, { type: "rename", workspaceId: shopping.id, name: "other" }, true)).json.code).toBe("reserved_name");
    expect(await dbSnapshot()).toBe(before);
  });

  it("renaming to its own name is nothing to do; changing only the case is allowed", async () => {
    const shopping = await makeWorkspace(ALICE, "Shopping");
    expect((await apply(ALICE, { type: "rename", workspaceId: shopping.id, name: "Shopping" }, true)).json).toMatchObject({ status: "nothing_to_do", message: m.NAME_UNCHANGED });
    expect((await apply(ALICE, { type: "rename", workspaceId: shopping.id, name: "SHOPPING" }, true)).json.status).toBe("done");
    expect(await wsName(shopping.id)).toBe("SHOPPING");
  });

  it("refuses a workspace that is gone or not the person's", async () => {
    const bobs = await makeWorkspace(BOB, "Bobs");
    const before = await dbSnapshot();
    expect((await apply(ALICE, { type: "rename", workspaceId: bobs.id, name: "Mine" }, true)).json).toMatchObject({ status: "refused", code: "not_found" });
    expect((await apply(ALICE, { type: "rename", workspaceId: crypto.randomUUID(), name: "Mine" }, true)).json.code).toBe("not_found");
    expect(await dbSnapshot()).toBe(before);
  });

  it("Undo restores the old name, but not over a name the person has since changed", async () => {
    const shopping = await makeWorkspace(ALICE, "Shopping");
    await apply(ALICE, { type: "rename", workspaceId: shopping.id, name: "Errands" }, true);
    expect((await apply(ALICE, { type: "undo" })).json.message).toBe("Undone. Renamed it back to Shopping.");
    expect(await wsName(shopping.id)).toBe("Shopping");

    await apply(ALICE, { type: "rename", workspaceId: shopping.id, name: "Errands" }, true);
    await patchWorkspace(shopping.id, { name: "My own name" });
    const undone = await apply(ALICE, { type: "undo" });
    expect(undone.json.message).toBe(m.undoRenameKept);
    expect(await wsName(shopping.id)).toBe("My own name");
  });

  it("Undo does not restore an old name that another workspace has taken since", async () => {
    const shopping = await makeWorkspace(ALICE, "Shopping");
    await apply(ALICE, { type: "rename", workspaceId: shopping.id, name: "Errands" }, true);
    await makeWorkspace(ALICE, "Shopping");
    expect((await apply(ALICE, { type: "undo" })).json.message).toBe(m.undoRenameKept);
    expect(await wsName(shopping.id)).toBe("Errands");
  });

  it("asks which when two workspaces match the name", async () => {
    await makeWorkspace(ALICE, "Trip 2025");
    await makeWorkspace(ALICE, "Trip 2026");
    installFakeCommandModel((input) => ans("rename", { subject: [wsId(input, "trip 2025"), wsId(input, "trip 2026")], subjectNamed: true, name: "Japan" }));
    const reply = await say(ALICE, "rename trip to Japan");
    expect(reply.json.kind).toBe("ask");
    expect(reply.json.choices.every((c: { step: { action: { type: string; name: string } } }) => c.step.action.type === "rename" && c.step.action.name === "Japan")).toBe(true);
  });
});

describe("merge workspaces", () => {
  it("shows both names and how many tabs will move, moves nothing until Confirm, then moves EVERY tab (open or not) and keeps the source", async () => {
    const tabs = await seedTabs(ALICE, [
      { url: "https://shop.example/a", title: "Shop A" },
      { url: "https://shop.example/b", title: "Shop B" },
      { url: "https://shop.example/c", title: "Shop C" },
    ]);
    const shopping = await makeWorkspace(ALICE, "Shopping");
    const errands = await makeWorkspace(ALICE, "Errands");
    for (const t of tabs) await patchTab(t.id, { workspaceId: shopping.id });
    await query("UPDATE tab_refs SET chrome_tab_id = NULL WHERE id = $1", [tabs[2].id]); // a closed tab: its record is still in the workspace
    installFakeCommandModel((input) => ans("merge", { subject: [wsId(input, "shopping")], subjectNamed: true, destination: [wsId(input, "errands")], destinationNamed: true }));
    const reply = await say(ALICE, "merge Shopping into Errands");
    expect(reply.json).toMatchObject({ kind: "action", understood: "Merging Shopping into Errands.", action: { type: "merge", fromWorkspaceId: shopping.id, intoWorkspaceId: errands.id } });

    const before = await dbSnapshot();
    const asked = await apply(ALICE, reply.json.action, false);
    expect(asked.json.preview.title).toBe("Merge Shopping into Errands (3 tabs will move)");
    expect(asked.json.preview.lines).toHaveLength(3);
    expect(await dbSnapshot()).toBe(before);

    const done = await apply(ALICE, reply.json.action, true);
    expect(done.json.status).toBe("done");
    expect(done.json.message).toBe("Moved 3 tabs from Shopping into Errands. Shopping still exists, with its chat and results, but has no tabs now.");
    expect(done.json.undo).toMatchObject({ kind: "merge", summary: "merged Shopping into Errands" });
    expect((await listTabs(ALICE)).every((t) => t.workspaceId === errands.id && t.placementSource === "user")).toBe(true);
    const source = (await query<{ status: string }>("SELECT status FROM workspaces WHERE id = $1", [shopping.id])).rows[0];
    expect(source.status).toBe("active"); // not archived, not deleted
  });

  it("touches nothing of the source but its tabs: its chat, checklist, and saved agent results stay exactly as they were", async () => {
    const shopping = await makeWorkspace(ALICE, "Shopping");
    const errands = await makeWorkspace(ALICE, "Errands");
    await putTabsIn(ALICE, shopping.id, [{ url: "https://shop.example/a", title: "Shop A" }, { url: "https://shop.example/b", title: "Shop B" }]);
    const userId = await userIdOf(ALICE);
    await addMessageAt(userId, shopping.id, "user", "what should I buy?", new Date(Date.now() - 60_000));
    await addPlanItem(userId, shopping.id, "Compare cameras", false, 0);
    installFakeAgentModel();
    await runAndWait(ALICE, shopping.id, "summarize");
    const rows = async () => JSON.stringify([
      (await query("SELECT * FROM messages WHERE workspace_id = $1 ORDER BY id", [shopping.id])).rows,
      (await query("SELECT * FROM plan_items WHERE workspace_id = $1 ORDER BY id", [shopping.id])).rows,
      (await query("SELECT * FROM action_runs WHERE workspace_id = $1 ORDER BY id", [shopping.id])).rows,
      (await query("SELECT id, name, emoji, status, created_at, updated_at FROM workspaces WHERE id = $1", [shopping.id])).rows,
    ]);
    const before = await rows();
    expect((await query("SELECT 1 FROM action_runs WHERE workspace_id = $1", [shopping.id])).rows).toHaveLength(1);
    const done = await apply(ALICE, { type: "merge", fromWorkspaceId: shopping.id, intoWorkspaceId: errands.id }, true);
    expect(done.json.status).toBe("done");
    expect(await rows()).toBe(before); // byte-identical: only tab_refs changed
  });

  it("refuses a merge into itself, and a missing or foreign workspace, before anything is written", async () => {
    const shopping = await makeWorkspace(ALICE, "Shopping");
    const bobs = await makeWorkspace(BOB, "Bobs");
    const before = await dbSnapshot();
    expect((await apply(ALICE, { type: "merge", fromWorkspaceId: shopping.id, intoWorkspaceId: shopping.id }, true)).json).toEqual({ status: "refused", code: "same_workspace", message: m.REFUSAL.same_workspace });
    expect((await apply(ALICE, { type: "merge", fromWorkspaceId: shopping.id, intoWorkspaceId: crypto.randomUUID() }, true)).json.code).toBe("not_found");
    expect((await apply(ALICE, { type: "merge", fromWorkspaceId: bobs.id, intoWorkspaceId: shopping.id }, true)).json.code).toBe("not_found");
    expect((await apply(ALICE, { type: "merge", fromWorkspaceId: shopping.id, intoWorkspaceId: bobs.id }, true)).json.code).toBe("not_found");
    expect(await dbSnapshot()).toBe(before);
  });

  it("says so, and changes nothing, when the source has no tabs", async () => {
    const shopping = await makeWorkspace(ALICE, "Shopping");
    const errands = await makeWorkspace(ALICE, "Errands");
    expect((await apply(ALICE, { type: "merge", fromWorkspaceId: shopping.id, intoWorkspaceId: errands.id }, true)).json).toMatchObject({ status: "nothing_to_do", message: m.NO_TABS_TO_MERGE });
  });

  it("interprets a self-merge into a plain message", async () => {
    await makeWorkspace(ALICE, "Shopping");
    installFakeCommandModel((input) => ans("merge", { subject: [wsId(input, "shopping")], subjectNamed: true, destination: [wsId(input, "shopping")], destinationNamed: true }));
    expect((await say(ALICE, "merge shopping into shopping")).json).toEqual({ kind: "say", message: m.SAME_WORKSPACE, help: null });
  });

  it("asks about one side when only that side is ambiguous, and asks for exact names when both are", async () => {
    await makeWorkspace(ALICE, "Trip 2025");
    await makeWorkspace(ALICE, "Trip 2026");
    const errands = await makeWorkspace(ALICE, "Errands");
    installFakeCommandModel((input) => ans("merge", { subject: [wsId(input, "trip 2025"), wsId(input, "trip 2026")], subjectNamed: true, destination: [wsId(input, "errands")], destinationNamed: true }));
    const one = await say(ALICE, "merge trip into errands");
    expect(one.json.kind).toBe("ask");
    expect(one.json.choices.every((c: { step: { action: { intoWorkspaceId: string } } }) => c.step.action.intoWorkspaceId === errands.id)).toBe(true);
    installFakeCommandModel((input) => ans("merge", { subject: [wsId(input, "trip 2025"), wsId(input, "trip 2026")], subjectNamed: true, destination: [wsId(input, "trip 2025"), wsId(input, "trip 2026")], destinationNamed: true }));
    expect((await say(ALICE, "merge trip into trip")).json).toEqual({ kind: "say", message: m.BOTH_AMBIGUOUS, help: null });
  });

  it("Undo puts every tab back where it was, with its old placement, and never touches a tab moved since", async () => {
    const tabs = await seedTabs(ALICE, [{ url: "https://shop.example/a", title: "Shop A" }, { url: "https://shop.example/b", title: "Shop B" }, { url: "https://shop.example/c", title: "Shop C" }]);
    const shopping = await makeWorkspace(ALICE, "Shopping");
    const errands = await makeWorkspace(ALICE, "Errands");
    const elsewhere = await makeWorkspace(ALICE, "Elsewhere");
    for (const t of tabs) await patchTab(t.id, { workspaceId: shopping.id });
    await apply(ALICE, { type: "merge", fromWorkspaceId: shopping.id, intoWorkspaceId: errands.id }, true);
    await patchTab(tabs[0].id, { workspaceId: elsewhere.id }); // the person moves one by hand afterwards
    const undone = await apply(ALICE, { type: "undo" });
    expect(undone.json.message).toBe("Undone. Put 2 tabs back. 1 tab kept where you put it.");
    expect(await tabWs(tabs[0].id)).toBe(elsewhere.id);
    expect(await tabWs(tabs[1].id)).toBe(shopping.id);
    expect(await tabWs(tabs[2].id)).toBe(shopping.id);
  });
});
