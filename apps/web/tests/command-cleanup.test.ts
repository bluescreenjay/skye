import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { query } from "@/src/db";
import { ModelError } from "@/src/llm/errors";
import * as m from "@/src/command/messages";
import { group, idsFor, installFakeModel, restoreModel } from "./cluster-helpers";
import { ans, apply, dbSnapshot, installFakeCommandModel, listTabs, person, restoreCommandModel, say, seedTabs, undoState } from "./command-helpers";
import { reset } from "./helpers";

const ALICE = "alice-device-token-0001";

const TABS = [
  { url: "https://shop.example/camera", title: "Camera" },
  { url: "https://shop.example/lens", title: "Lens" },
  { url: "https://travel.example/flights", title: "Flights" },
  { url: "https://travel.example/hotel", title: "Hotel" },
];

beforeEach(async () => {
  await reset();
  await person(ALICE);
});
afterEach(() => {
  restoreCommandModel();
  restoreModel();
});

const twoGroups = () =>
  installFakeModel((input) => [group("Shopping", idsFor(input, "shop.example"), 0.9), group("Travel", idsFor(input, "travel.example"), 0.9)]);
const tabCount = async () => Number((await query<{ n: string }>("SELECT count(*) AS n FROM tab_refs")).rows[0].n);

describe("clean up my browser", () => {
  it("is understood as one action, with the loose-tab count, and changes nothing", async () => {
    await seedTabs(ALICE, TABS);
    installFakeCommandModel(ans("cleanup"));
    const before = await dbSnapshot();
    const reply = await say(ALICE, "clean up my browser");
    expect(reply.json).toEqual({ kind: "action", understood: "Cleaning up: organizing your 4 loose tabs, then looking for duplicate tabs.", action: { type: "cleanup" } });
    expect(await dbSnapshot()).toBe(before);
  });

  it("still offers the duplicate step when there are no loose tabs (it is not refused like organize)", async () => {
    installFakeCommandModel(ans("cleanup"));
    const reply = await say(ALICE, "clean up my browser");
    expect(reply.json).toEqual({ kind: "action", understood: "Cleaning up: looking for duplicate tabs.", action: { type: "cleanup" } });
  });

  it("organizes the loose tabs, then hands the duplicate scan to the extension", async () => {
    await seedTabs(ALICE, TABS);
    const cluster = twoGroups();
    const done = await apply(ALICE, { type: "cleanup" });
    expect(cluster.calls).toHaveLength(1);
    expect(done.json).toMatchObject({ status: "done", next: "scan_duplicates", counts: { moved: 4, workspacesCreated: 2 } });
    expect(done.json.message).toBe("Moved 4 tabs into 2 workspaces.");
    expect(done.json.undo).toMatchObject({ kind: "organize" });
    // Undo of a clean-up is the organize step (closing tabs is not undoable, and the server never closes one).
    expect((await apply(ALICE, { type: "undo" })).json.status).toBe("done");
    expect((await listTabs(ALICE)).every((t) => t.workspaceId === null)).toBe(true);
  });

  it("offers the duplicate scan even when nothing was organized, without a new undo row", async () => {
    await seedTabs(ALICE, TABS);
    twoGroups();
    await apply(ALICE, { type: "cleanup" });
    const first = (await undoState(ALICE)).json.undo;
    const again = await apply(ALICE, { type: "cleanup" }); // nothing changed since: the run is skipped
    expect(again.json).toMatchObject({ status: "done", message: m.CLEANUP_NOTHING_ORGANIZED, next: "scan_duplicates", counts: { moved: 0 } });
    expect((await undoState(ALICE)).json.undo).toEqual(first);
  });

  it("never closes anything: the server has no way to, and no tab record is removed", async () => {
    await seedTabs(ALICE, TABS);
    twoGroups();
    const before = await tabCount();
    await apply(ALICE, { type: "cleanup" });
    expect(await tabCount()).toBe(before);
    expect((await listTabs(ALICE)).filter((t) => t.chromeTabId !== null)).toHaveLength(4); // every tab is still bound to its live tab
  });

  it("a failed organize is a plain refusal and offers no duplicate scan", async () => {
    await seedTabs(ALICE, TABS);
    installFakeModel(() => {
      throw new ModelError();
    });
    const result = await apply(ALICE, { type: "cleanup" });
    expect(result.json).toEqual({ status: "refused", code: "model_error", message: m.REFUSAL.model_error });
    expect(result.json.next).toBeUndefined();
  });

  it("makes no interpretation request when applied", async () => {
    await seedTabs(ALICE, TABS);
    twoGroups();
    const fake = installFakeCommandModel();
    await apply(ALICE, { type: "cleanup" });
    expect(fake.calls).toHaveLength(0);
  });
});
