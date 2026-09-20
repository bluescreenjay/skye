import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PATCH as tabRefPatch } from "@/app/api/tab-refs/[id]/route";
import { query } from "@/src/db";
import { ModelError } from "@/src/llm/errors";
import * as m from "@/src/command/messages";
import { gate, group, idsFor, installFakeModel, restoreModel } from "./cluster-helpers";
import {
  ans,
  apply,
  ctxHome,
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

const SEVEN = [
  { url: "https://shop.example/camera", title: "Camera review" },
  { url: "https://shop.example/lens", title: "Lens deals" },
  { url: "https://shop.example/tripod", title: "Tripod prices" },
  { url: "https://travel.example/flights", title: "Flights to Osaka" },
  { url: "https://travel.example/hotel", title: "Hotel in Kyoto" },
  { url: "https://cook.example/ramen", title: "Ramen recipe" },
  { url: "https://cook.example/gyoza", title: "Gyoza recipe" },
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

/** A cluster fake that makes two confident groups and one it is unsure of. */
const threeGroups = () =>
  installFakeModel((input) => [
    group("Shopping", idsFor(input, "shop.example"), 0.9),
    group("Travel", idsFor(input, "travel.example"), 0.9),
    group("Cooking", idsFor(input, "cook.example"), 0.4), // below the bar: a suggestion, never a move
  ]);

describe("interpret: organize", () => {
  it("says what it understood, with the count of loose tabs, and changes nothing", async () => {
    await seedTabs(ALICE, SEVEN.slice(0, 6));
    const cluster = threeGroups();
    const fake = installFakeCommandModel(ans("organize"));
    const before = await dbSnapshot();
    const reply = await say(ALICE, "organize my tabs");
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ kind: "action", understood: "Organizing your 6 loose tabs.", action: { type: "organize" } });
    expect(fake.calls).toHaveLength(1);
    expect(cluster.calls).toHaveLength(0); // interpreting never starts the organize
    expect(await dbSnapshot()).toBe(before);
  });

  it("says there is nothing to organize when no tab is loose, and never starts an organize", async () => {
    const cluster = threeGroups();
    installFakeCommandModel(ans("organize"));
    expect((await say(ALICE, "organize my tabs")).json).toEqual({ kind: "say", message: m.NO_LOOSE_TABS, help: null });
    // Tabs that are all placed by the person are not loose either.
    const ws = await makeWorkspace(ALICE, "Kyoto trip");
    await putTabsIn(ALICE, ws.id, SEVEN.slice(0, 3));
    expect((await say(ALICE, "organize my tabs")).json.kind).toBe("say");
    expect(cluster.calls).toHaveLength(0);
  });

  it("asks rather than acts when the interpreter is not sure", async () => {
    await seedTabs(ALICE, SEVEN);
    installFakeCommandModel(ans("organize", { confidence: 0.5 }));
    const reply = await say(ALICE, "tidy up maybe?");
    expect(reply.json).toEqual({ kind: "say", message: m.NOT_SURE, help: [...m.HELP] });
  });
});

describe("apply: organize", () => {
  it("runs Home's own organize once, moves only loose tabs, and leaves a hand-placed tab alone", async () => {
    const mine = await makeWorkspace(ALICE, "Mine");
    await putTabsIn(ALICE, mine.id, [{ url: "https://shop.example/handplaced", title: "Placed by me" }]);
    await seedTabs(ALICE, SEVEN);
    const cluster = threeGroups();
    const fake = installFakeCommandModel(); // installed to prove apply makes NO interpretation request
    const reply = await apply(ALICE, { type: "organize" });

    expect(reply.status).toBe(200);
    expect(reply.json.status).toBe("done");
    expect(cluster.calls).toHaveLength(1);
    expect(fake.calls).toHaveLength(0);
    expect(reply.json.counts).toMatchObject({ moved: 5, workspacesCreated: 2, suggestions: 1 });
    expect(reply.json.message).toBe("Moved 5 tabs into 2 workspaces. 1 left as a suggestion.");
    expect(reply.json.next).toBeNull();
    expect(reply.json.undo).toMatchObject({ kind: "organize" });
    expect((await undoState(ALICE)).json.undo).toMatchObject({ kind: "organize", summary: "organized 5 tabs into 2 workspaces" });

    const tabs = await listTabs(ALICE);
    const placed = tabs.find((t) => t.url === "https://shop.example/handplaced")!;
    expect([placed.workspaceId, placed.placementSource]).toEqual([mine.id, "user"]); // never moved
    expect(tabs.filter((t) => t.placementSource === "ai")).toHaveLength(5);
    expect(tabs.find((t) => t.url === "https://cook.example/ramen")!.workspaceId).toBeNull(); // the suggestion moved nothing
  });

  it("Undo puts back exactly the tabs the run moved, and keeps a tab the person moved since", async () => {
    await seedTabs(ALICE, SEVEN);
    threeGroups();
    await apply(ALICE, { type: "organize" });
    const mineWs = await makeWorkspace(ALICE, "Mine");
    const camera = (await listTabs(ALICE)).find((t) => t.url === "https://shop.example/camera")!;
    const moved = await read(tabRefPatch(req("PATCH", `/api/tab-refs/${camera.id}`, ALICE, { workspaceId: mineWs.id }), { params: Promise.resolve({ id: camera.id }) }));
    expect(moved.status).toBe(200);

    const undone = await apply(ALICE, { type: "undo" });
    expect(undone.json.status).toBe("done");
    expect(undone.json.message).toBe("Undone. Put 4 tabs back. 1 tab kept where you put it.");
    const after = await listTabs(ALICE);
    expect(after.filter((t) => t.placementSource === "ai")).toHaveLength(0);
    const cam = after.find((t) => t.id === camera.id)!;
    expect([cam.workspaceId, cam.placementSource]).toEqual([mineWs.id, "user"]);
    expect((await undoState(ALICE)).json).toEqual({ undo: null });
    expect((await apply(ALICE, { type: "undo" })).json).toMatchObject({ status: "nothing_to_do", message: m.NOTHING_TO_UNDO });
  });

  it("is nothing to do, and leaves the earlier undo row alone, when the run applies nothing", async () => {
    await seedTabs(ALICE, SEVEN);
    const cluster = threeGroups();
    await apply(ALICE, { type: "organize" });
    const first = (await undoState(ALICE)).json.undo;
    const again = await apply(ALICE, { type: "organize" }); // nothing changed since: the run is skipped
    expect(again.json).toMatchObject({ status: "nothing_to_do", message: m.NOTHING_TO_ORGANIZE });
    expect(cluster.calls).toHaveLength(1);
    expect((await undoState(ALICE)).json.undo).toEqual(first);
  });

  it("refuses when an organize is already running", async () => {
    await seedTabs(ALICE, SEVEN);
    const hold = gate();
    installFakeModel(async (input) => {
      await hold.wait;
      return [group("Shopping", idsFor(input, "shop.example"), 0.9)];
    });
    const first = apply(ALICE, { type: "organize" });
    await new Promise((r) => setTimeout(r, 100));
    const second = await apply(ALICE, { type: "organize" });
    expect(second.json).toEqual({ status: "refused", code: "run_in_progress", message: m.REFUSAL.run_in_progress });
    hold.release();
    expect((await first).json.status).toBe("done");
  });

  it("refuses plainly when the AI service fails, leaving nothing half-done", async () => {
    await seedTabs(ALICE, SEVEN);
    installFakeModel(() => {
      throw new ModelError();
    });
    const before = (await query("SELECT count(*) AS n FROM workspaces")).rows[0];
    const reply = await apply(ALICE, { type: "organize" });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ status: "refused", code: "model_error", message: m.REFUSAL.model_error });
    expect((await query("SELECT count(*) AS n FROM workspaces")).rows[0]).toEqual(before);
    expect((await undoState(ALICE)).json).toEqual({ undo: null });
    expect((await listTabs(ALICE)).every((t) => t.workspaceId === null)).toBe(true);
  });

  it("does not need a confirmation", async () => {
    await seedTabs(ALICE, SEVEN);
    threeGroups();
    expect((await apply(ALICE, { type: "organize" }, false)).json.status).toBe("done");
  });
});

describe("show and open a workspace", () => {
  it("show is a navigation to Home and changes no data", async () => {
    await makeWorkspace(ALICE, "Kyoto trip");
    installFakeCommandModel(ans("show"));
    const before = await dbSnapshot();
    const reply = await say(ALICE, "show my workspaces");
    expect(reply.json).toEqual({ kind: "navigate", understood: "Showing your workspaces.", target: { kind: "home" } });
    expect(await dbSnapshot()).toBe(before);
  });

  it("opens a named workspace, and only one of the person's own", async () => {
    await makeWorkspace(ALICE, "Kyoto trip");
    await makeWorkspace(BOB, "Bobs secret plan");
    const fake = installFakeCommandModel((input) => ans("open_workspace", { subject: [wsId(input, "kyoto trip")], subjectNamed: true }));
    const reply = await say(ALICE, "open kyoto");
    expect(reply.json).toMatchObject({ kind: "navigate", understood: "Opening Kyoto trip.", target: { kind: "workspace" } });
    expect(fake.calls[0].prompt).not.toContain("Bobs secret plan");
  });

  it("says plainly when a named workspace does not exist, listing the person's own, never Bob's", async () => {
    await makeWorkspace(ALICE, "Kyoto trip");
    await makeWorkspace(ALICE, "Hackathon");
    await makeWorkspace(BOB, "Bobs secret plan");
    // The model names an id the server never sent (Bob's would be like this): it is dropped, not guessed.
    installFakeCommandModel(ans("open_workspace", { subject: ["w9"], subjectNamed: true }));
    const reply = await say(ALICE, "open bobs plan");
    expect(reply.json).toEqual({ kind: "say", message: "I couldn't find a workspace like that. Yours are: Kyoto trip, Hackathon.", help: null });
  });

  it("asks which when two workspaces match, with a button for each, and changes nothing", async () => {
    await makeWorkspace(ALICE, "Hackathon 2025");
    await makeWorkspace(ALICE, "Hackathon 2026");
    installFakeCommandModel((input) => ans("open_workspace", { subject: [wsId(input, "hackathon 2025"), wsId(input, "hackathon 2026")], subjectNamed: true }));
    const before = await dbSnapshot();
    const reply = await say(ALICE, "open hackathon");
    expect(reply.json.kind).toBe("ask");
    expect(reply.json.question).toBe(m.WHICH_WORKSPACE);
    expect(reply.json.choices.map((c: { label: string }) => c.label)).toEqual(["Hackathon 2025", "Hackathon 2026"]);
    expect(reply.json.choices.every((c: { step: { kind: string } }) => c.step.kind === "navigate")).toBe(true);
    expect(await dbSnapshot()).toBe(before);
  });

  it("'this workspace' is the single expanded card on Home, and is asked about when there is none", async () => {
    const kyoto = await makeWorkspace(ALICE, "Kyoto trip");
    installFakeCommandModel(ans("open_workspace", { thisWorkspace: true }));
    const some = await say(ALICE, "open this workspace", ctxHome({ expandedWorkspaceIds: [kyoto.id] }));
    expect(some.json).toMatchObject({ kind: "navigate", target: { kind: "workspace", workspaceId: kyoto.id } });
    const none = await say(ALICE, "open this workspace", ctxHome());
    expect(none.json).toEqual({ kind: "say", message: m.CURRENT_NONE, help: null });
    const bobsWs = await makeWorkspace(BOB, "Bobs");
    // An expanded id that is not Alice's counts as no card at all.
    expect((await say(ALICE, "open this workspace", ctxHome({ expandedWorkspaceIds: [bobsWs.id] }))).json.message).toBe(m.CURRENT_NONE);
  });
});
