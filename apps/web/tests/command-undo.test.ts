import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as undoRunPost } from "@/app/api/cluster/runs/[id]/undo/route";
import { PATCH as tabRefPatch } from "@/app/api/tab-refs/[id]/route";
import { query } from "@/src/db";
import * as m from "@/src/command/messages";
import { group, idsFor, installFakeModel, restoreModel } from "./cluster-helpers";
import { apply, dbSnapshot, installFakeCommandModel, listTabs, makeWorkspace, person, restoreCommandModel, seedTabs, undoState } from "./command-helpers";
import { read, req, reset } from "./helpers";

const ALICE = "alice-device-token-0001";
const BOB = "bob-device-token-000002";

const TABS = [
  { url: "https://shop.example/a", title: "Shop A" },
  { url: "https://shop.example/b", title: "Shop B" },
  { url: "https://travel.example/c", title: "Travel C" },
  { url: "https://travel.example/d", title: "Travel D" },
];

beforeEach(async () => {
  await reset();
  await person(ALICE);
  await person(BOB);
});
afterEach(() => {
  restoreCommandModel();
  restoreModel();
});

const placement = async (token = ALICE) => JSON.stringify((await listTabs(token)).map((t) => [t.url, t.workspaceId, t.placementSource]).sort());
const activeNames = async () => (await query<{ name: string }>("SELECT name FROM workspaces WHERE status <> 'archived' ORDER BY name")).rows.map((r) => r.name);
const patchTab = (id: string, body: Record<string, unknown>) =>
  read(tabRefPatch(req("PATCH", `/api/tab-refs/${id}`, ALICE, body), { params: Promise.resolve({ id }) }));
const twoGroups = () => installFakeModel((input) => [group("Shopping", idsFor(input, "shop.example"), 0.9), group("Travel", idsFor(input, "travel.example"), 0.9)]);

/** Every kind of change the bar makes, each as a function that makes it (and returns nothing else). */
const KINDS: { kind: string; make: () => Promise<void> }[] = [
  { kind: "organize", make: async () => void (twoGroups(), await apply(ALICE, { type: "organize" })) },
  {
    kind: "group",
    make: async () => void (await apply(ALICE, { type: "group", tabRefIds: (await listTabs(ALICE)).slice(0, 2).map((t) => t.id), target: { newName: "Shopping" } }, true)),
  },
  {
    kind: "move",
    make: async () => {
      const dest = await makeWorkspace(ALICE, "Dest");
      await apply(ALICE, { type: "move", tabRefIds: (await listTabs(ALICE)).slice(0, 2).map((t) => t.id), toWorkspaceId: dest.id }, true);
    },
  },
  {
    kind: "merge",
    make: async () => {
      const [a, b] = [await makeWorkspace(ALICE, "Source"), await makeWorkspace(ALICE, "Target")];
      for (const t of (await listTabs(ALICE)).slice(0, 2)) await patchTab(t.id, { workspaceId: a.id });
      await apply(ALICE, { type: "merge", fromWorkspaceId: a.id, intoWorkspaceId: b.id }, true);
    },
  },
  { kind: "create", make: async () => void (await apply(ALICE, { type: "create", name: "Fresh", tabRefIds: (await listTabs(ALICE)).map((t) => t.id) })) },
  {
    kind: "rename",
    make: async () => {
      const ws = await makeWorkspace(ALICE, "Old name");
      await apply(ALICE, { type: "rename", workspaceId: ws.id, name: "New name" }, true);
    },
  },
];

describe("Undo reverses exactly one change, whatever it was", () => {
  it.each(KINDS)("$kind: the tabs and workspaces are as they were before it", async ({ kind, make }) => {
    await seedTabs(ALICE, TABS);
    // Snapshots are taken after any setup the change itself needs (a workspace it works on), then the change is made.
    const setup = kind === "merge" || kind === "move" || kind === "rename";
    let before = "";
    let namesBefore: string[] = [];
    if (!setup) {
      before = await placement();
      namesBefore = await activeNames();
    }
    await make();
    expect((await undoState(ALICE)).json.undo?.kind).toBe(kind);
    const undone = await apply(ALICE, { type: "undo" });
    expect(undone.json.status, JSON.stringify(undone.json)).toBe("done");
    if (!setup) {
      expect(await placement()).toBe(before);
      expect(await activeNames()).toEqual(namesBefore);
    } else if (kind === "rename") {
      expect(await activeNames()).toContain("Old name");
      expect(await activeNames()).not.toContain("New name");
    } else {
      // Every tab is back where it was: in Other for a move, in "Source" for a merge.
      const tabs = await listTabs(ALICE);
      const expectedIn = kind === "merge" ? "Source" : null;
      const source = expectedIn ? (await query<{ id: string }>("SELECT id FROM workspaces WHERE name = 'Source'")).rows[0].id : null;
      expect(tabs.slice(0, 2).every((t) => tabs.find((x) => x.id === t.id)!.workspaceId === source || (kind === "move" && t.workspaceId === null))).toBe(true);
    }
    expect((await undoState(ALICE)).json).toEqual({ undo: null });
    expect((await apply(ALICE, { type: "undo" })).json).toMatchObject({ status: "nothing_to_do", message: m.NOTHING_TO_UNDO });
  });

  it.each(KINDS.filter((k) => ["group", "move", "create"].includes(k.kind)))("$kind: a tab the person moved since is kept, and only that one", async ({ make }) => {
    const tabs = await seedTabs(ALICE, TABS);
    const elsewhere = await makeWorkspace(ALICE, "Elsewhere");
    await make();
    const moved = (await listTabs(ALICE)).find((t) => t.workspaceId !== null && t.workspaceId !== elsewhere.id)!;
    await patchTab(moved.id, { workspaceId: elsewhere.id });
    const undone = await apply(ALICE, { type: "undo" });
    expect(undone.json.message).toContain("1 tab kept where you put it.");
    expect((await listTabs(ALICE)).find((t) => t.id === moved.id)!.workspaceId).toBe(elsewhere.id);
    expect(tabs.length).toBe(4);
  });
});

describe("the ten-minute window", () => {
  const age = (minutes: number) => query(`UPDATE command_undo SET created_at = now() - ($1::text || ' minutes')::interval`, [String(minutes)]);

  it("a change is still undoable at 9 minutes, and gone at 11: reading it deletes the row, and Undo changes nothing", async () => {
    const tabs = await seedTabs(ALICE, TABS);
    await apply(ALICE, { type: "create", name: "Fresh", tabRefIds: tabs.map((t) => t.id) });

    await age(9);
    expect((await undoState(ALICE)).json.undo).toMatchObject({ kind: "create" });

    await age(11);
    const before = await placement();
    expect((await undoState(ALICE)).json).toEqual({ undo: null });
    expect((await query("SELECT 1 FROM command_undo")).rows).toHaveLength(0); // deleted on read: no sweeper needed
    expect((await apply(ALICE, { type: "undo" })).json).toMatchObject({ status: "nothing_to_do", message: m.NOTHING_TO_UNDO });
    expect(await placement()).toBe(before); // the change stands
  });

  it("an expired row that is only ever touched by Undo is treated as nothing to undo, and removed", async () => {
    const tabs = await seedTabs(ALICE, TABS);
    await apply(ALICE, { type: "create", name: "Fresh", tabRefIds: tabs.map((t) => t.id) });
    await age(11);
    const before = await placement();
    expect((await apply(ALICE, { type: "undo" })).json.status).toBe("nothing_to_do");
    expect((await query("SELECT 1 FROM command_undo")).rows).toHaveLength(0);
    expect(await placement()).toBe(before);
  });

  it("expiresAt is ten minutes after the change", async () => {
    const tabs = await seedTabs(ALICE, TABS);
    await apply(ALICE, { type: "create", name: "Fresh", tabRefIds: tabs.map((t) => t.id) });
    const created = new Date((await query<{ t: Date }>("SELECT created_at AS t FROM command_undo")).rows[0].t).getTime();
    const expires = new Date((await undoState(ALICE)).json.undo.expiresAt).getTime();
    expect(expires - created).toBe(10 * 60_000);
  });

  it("a change that is made again restarts the window", async () => {
    const tabs = await seedTabs(ALICE, TABS);
    await apply(ALICE, { type: "create", name: "First", tabRefIds: tabs.slice(0, 2).map((t) => t.id) });
    await age(9);
    await apply(ALICE, { type: "create", name: "Second", tabRefIds: tabs.slice(2).map((t) => t.id) });
    const created = new Date((await query<{ t: Date }>("SELECT created_at AS t FROM command_undo")).rows[0].t).getTime();
    expect(Date.now() - created).toBeLessThan(5_000);
  });
});

describe("only the most recent change", () => {
  it("a second changing command replaces the first: the first can no longer be undone", async () => {
    const tabs = await seedTabs(ALICE, TABS);
    await apply(ALICE, { type: "create", name: "First", tabRefIds: tabs.slice(0, 2).map((t) => t.id) });
    await apply(ALICE, { type: "create", name: "Second", tabRefIds: tabs.slice(2).map((t) => t.id) });
    expect((await query("SELECT 1 FROM command_undo")).rows).toHaveLength(1);
    await apply(ALICE, { type: "undo" });
    expect((await apply(ALICE, { type: "undo" })).json.status).toBe("nothing_to_do");
    expect((await listTabs(ALICE)).filter((t) => t.workspaceId !== null)).toHaveLength(2); // "First" stands
  });

  it("a command that changes nothing leaves the row alone", async () => {
    const tabs = await seedTabs(ALICE, TABS);
    const dest = await makeWorkspace(ALICE, "Dest");
    await apply(ALICE, { type: "move", tabRefIds: tabs.map((t) => t.id), toWorkspaceId: dest.id }, true);
    const row = (await query("SELECT * FROM command_undo")).rows[0];
    expect((await apply(ALICE, { type: "move", tabRefIds: tabs.map((t) => t.id), toWorkspaceId: dest.id }, true)).json.status).toBe("nothing_to_do");
    expect((await apply(ALICE, { type: "rename", workspaceId: dest.id, name: "Dest" }, true)).json.status).toBe("nothing_to_do");
    expect((await apply(ALICE, { type: "move", tabRefIds: [crypto.randomUUID()], toWorkspaceId: dest.id }, true)).json.status).toBe("refused");
    expect((await query("SELECT * FROM command_undo")).rows[0]).toEqual(row);
  });

  it("a refused command leaves the row alone too", async () => {
    const tabs = await seedTabs(ALICE, TABS);
    await apply(ALICE, { type: "create", name: "Fresh", tabRefIds: tabs.map((t) => t.id) });
    const row = (await query("SELECT * FROM command_undo")).rows[0];
    // The tabs were just placed by the person, so a create asks first; confirmed, it reaches the name rule.
    expect((await apply(ALICE, { type: "create", name: "fresh", tabRefIds: tabs.map((t) => t.id) }, true)).json.code).toBe("name_taken");
    expect((await query("SELECT * FROM command_undo")).rows[0]).toEqual(row);
  });
});

describe("Undo and other people, other calls, and other paths", () => {
  it("two people's undo rows are independent", async () => {
    const [mine, bobs] = [await seedTabs(ALICE, TABS), await seedTabs(BOB, TABS)];
    await apply(ALICE, { type: "create", name: "Fresh", tabRefIds: mine.map((t) => t.id) });
    expect((await apply(BOB, { type: "undo" })).json.status).toBe("nothing_to_do");
    expect((await undoState(ALICE)).json.undo).toMatchObject({ kind: "create" });
    await apply(BOB, { type: "create", name: "Fresh", tabRefIds: bobs.map((t) => t.id) });
    await apply(ALICE, { type: "undo" });
    expect((await undoState(BOB)).json.undo).toMatchObject({ kind: "create" }); // Bob's change is still his to undo
    expect((await listTabs(BOB)).every((t) => t.workspaceId !== null)).toBe(true);
  });

  it("Undo makes no interpretation request and no clustering request (organize's own undo is the 004 code)", async () => {
    const tabs = await seedTabs(ALICE, TABS);
    const fake = installFakeCommandModel();
    const cluster = twoGroups();
    await apply(ALICE, { type: "create", name: "Fresh", tabRefIds: tabs.map((t) => t.id) });
    await apply(ALICE, { type: "undo" });
    expect(cluster.calls).toHaveLength(0);
    await apply(ALICE, { type: "organize" });
    expect(cluster.calls).toHaveLength(1);
    await apply(ALICE, { type: "undo" });
    expect(cluster.calls).toHaveLength(1); // undoing an organize does not ask the model again
    expect(fake.calls).toHaveLength(0);
  });

  it("an organize the person already undid through the 004 route is nothing to undo, and the row is cleared", async () => {
    await seedTabs(ALICE, TABS);
    twoGroups();
    await apply(ALICE, { type: "organize" });
    const runId = (await query<{ id: string }>("SELECT id FROM cluster_runs ORDER BY started_at DESC LIMIT 1")).rows[0].id;
    const direct = await read(undoRunPost(req("POST", `/api/cluster/runs/${runId}/undo`, ALICE), { params: Promise.resolve({ id: runId }) }));
    expect(direct.status).toBe(200);
    const undone = await apply(ALICE, { type: "undo" });
    expect(undone.json.status).toBe("done"); // 004's undo of an undone run is a harmless no-op that reverts nothing
    expect(undone.json.counts.moved).toBe(0);
    expect((await undoState(ALICE)).json).toEqual({ undo: null });
  });

  it("two Undo calls at once: one does it, the other finds nothing", async () => {
    const tabs = await seedTabs(ALICE, TABS);
    await apply(ALICE, { type: "create", name: "Fresh", tabRefIds: tabs.map((t) => t.id) });
    const [one, two] = await Promise.all([apply(ALICE, { type: "undo" }), apply(ALICE, { type: "undo" })]);
    expect([one.json.status, two.json.status].sort()).toEqual(["done", "nothing_to_do"]);
    expect((await listTabs(ALICE)).every((t) => t.workspaceId === null)).toBe(true);
  });

  it("never changes the database when there is no row", async () => {
    await seedTabs(ALICE, TABS);
    const before = await dbSnapshot();
    await apply(ALICE, { type: "undo" });
    expect(await dbSnapshot()).toBe(before);
  });
});
