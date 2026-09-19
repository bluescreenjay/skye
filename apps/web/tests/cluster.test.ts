import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as overviewGet } from "@/app/api/overview/route";
import { GET as resolveGet } from "@/app/api/resolve/route";
import { GET as workspacesGet } from "@/app/api/workspaces/route";
import { GET as runGet } from "@/app/api/cluster/runs/[id]/route";
import { POST as undoPost } from "@/app/api/cluster/runs/[id]/undo/route";
import { GET as runsGet, POST as runsPost } from "@/app/api/cluster/runs/route";
import { POST as sessionPost } from "@/app/api/session/route";
import { POST as acceptPost } from "@/app/api/suggestions/[id]/accept/route";
import { POST as ignorePost } from "@/app/api/suggestions/[id]/ignore/route";
import { GET as suggestionsGet } from "@/app/api/suggestions/route";
import { PATCH as tabRefPatch } from "@/app/api/tab-refs/[id]/route";
import { PUT as tabRefsPut } from "@/app/api/tab-refs/route";
import { PATCH as workspacePatch } from "@/app/api/workspaces/[id]/route";
import { query } from "@/src/db";
import { BudgetExceededError, ModelError } from "@/src/llm/errors";
import { spend } from "@/src/llm/budget";
import { MAX_TABS_PER_RUN } from "@/src/cluster/model";
import { gate, group, idsFor, installFakeModel, listTabs, makeWorkspace, restoreModel, seedTabs } from "./cluster-helpers";
import { read, req, reset } from "./helpers";

const ALICE = "alice-device-token-0001";
const BOB = "bob-device-token-000002";

beforeEach(reset);
afterEach(() => {
  restoreModel();
  delete process.env.LLM_DAILY_CAP;
});

const pair = (token: string) => read(sessionPost(req("POST", "/api/session", null, { deviceToken: token })));
const run = (token: string | null, body?: unknown) => read(runsPost(req("POST", "/api/cluster/runs", token, body)));
const runsList = (token: string, qs = "") => read(runsGet(req("GET", `/api/cluster/runs${qs}`, token)));
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const suggestionList = (token: string, status = "") => read(suggestionsGet(req("GET", `/api/suggestions${status}`, token)));
const accept = (token: string, id: string) => read(acceptPost(req("POST", "/x", token), ctx(id)));
const ignore = (token: string, id: string) => read(ignorePost(req("POST", "/x", token), ctx(id)));
const count = async (sql: string, params: unknown[] = []) => (await query<{ n: number }>(sql, params)).rows[0].n;

const TRIP = ["https://trip.example/kyoto-flights", "https://trip.example/kyoto-hotels", "https://trip.example/kyoto-food"];
const CODE = ["https://code.example/vitest", "https://code.example/postgres"];
const ONE_OFF = "https://oneoff.example/cats";
const tabs = (urls: string[]) => urls.map((url) => ({ url }));

/** A model that finds the usual two groups: a trip and a coding project. */
const twoGroups = () =>
  installFakeModel((input) => [
    group("Kyoto trip", idsFor(input, "trip.example"), 0.92, { emoji: "🗾" }),
    group("Coding project", idsFor(input, "code.example"), 0.9, { emoji: "💻" }),
  ]);

describe("user story 1: a messy tab set becomes named workspaces", () => {
  it("creates a workspace per confident group and assigns its tabs as AI placements", async () => {
    await seedTabs(ALICE, tabs([...TRIP, ...CODE, ONE_OFF]));
    twoGroups();

    const reply = await run(ALICE);
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ skipped: false, leftOut: 0, suggestions: [] });
    expect(reply.json.run).toMatchObject({ status: "succeeded", consideredCount: 6, appliedCount: 5, discardedCount: 0 });
    expect(reply.json.applied.map((a: { workspace: { name: string } }) => a.workspace.name).sort()).toEqual(["Coding project", "Kyoto trip"]);
    expect(reply.json.applied.every((a: { created: boolean }) => a.created)).toBe(true);

    const stored = await listTabs(ALICE);
    const kyoto = reply.json.applied.find((a: { workspace: { name: string } }) => a.workspace.name === "Kyoto trip");
    for (const url of TRIP) {
      expect(stored.find((t) => t.url === url)).toMatchObject({ workspaceId: kyoto.workspace.id, placementSource: "ai" });
    }
    expect(kyoto.workspace).toMatchObject({ emoji: "🗾", status: "active" });

    // the undo log and the activity history both know
    expect(await count("SELECT count(*)::int AS n FROM cluster_run_moves WHERE run_id = $1", [reply.json.run.id])).toBe(5);
    expect(await count("SELECT count(*)::int AS n FROM tab_events WHERE event_type = 'reassigned'")).toBe(5);
    expect(reply.json.run.createdWorkspaceIds).toHaveLength(2);
  });

  it("leaves a tab that fits no group in Other, unplaced", async () => {
    await seedTabs(ALICE, tabs([...TRIP, ONE_OFF]));
    twoGroups();
    await run(ALICE);
    expect((await listTabs(ALICE)).find((t) => t.url === ONE_OFF)).toMatchObject({ workspaceId: null, placementSource: null });
  });

  it("still sends a tab whose page text could not be read (empty snippet)", async () => {
    await seedTabs(ALICE, [{ url: "https://blank.example/a", snippet: "" }, { url: "https://blank.example/b", snippet: "" }]);
    const model = installFakeModel(() => []);
    await run(ALICE);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].tabs.map((t) => t.url).sort()).toEqual(["https://blank.example/a", "https://blank.example/b"]);
    expect(model.calls[0].tabs.every((t) => t.snippet === "")).toBe(true);
  });

  it("finishes quietly, without asking the model, when there are fewer than two candidates", async () => {
    await seedTabs(ALICE, tabs([ONE_OFF]));
    const model = installFakeModel(() => []);
    const reply = await run(ALICE);
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ skipped: false, applied: [], suggestions: [] });
    expect(reply.json.run.status).toBe("succeeded");
    expect(model.calls).toHaveLength(0);
  });

  it("nothing found is a normal success", async () => {
    await seedTabs(ALICE, tabs([...TRIP, ONE_OFF]));
    installFakeModel(() => []);
    const reply = await run(ALICE);
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ skipped: false, applied: [], suggestions: [] });
    expect(reply.json.run).toMatchObject({ status: "succeeded", appliedCount: 0 });
  });

  it("sends at most 100 tabs and reports how many were left out", async () => {
    const many = Array.from({ length: MAX_TABS_PER_RUN + 5 }, (_, i) => ({ url: `https://many.example/page-${i}` }));
    await seedTabs(ALICE, many);
    const model = installFakeModel(() => []);
    const reply = await run(ALICE);
    expect(model.calls[0].tabs).toHaveLength(MAX_TABS_PER_RUN);
    expect(reply.json.leftOut).toBe(5);
    expect(reply.json.run).toMatchObject({ consideredCount: MAX_TABS_PER_RUN, leftOutCount: 5 });
  });

  it("discards an unusable group but keeps the good one in the same answer", async () => {
    await seedTabs(ALICE, tabs([...TRIP, ...CODE]));
    installFakeModel((input) => [
      group("Group 1", idsFor(input, "code.example")), // generic name
      group("Kyoto trip", idsFor(input, "trip.example")),
    ]);
    const reply = await run(ALICE);
    expect(reply.json.run).toMatchObject({ appliedCount: 3, discardedCount: 1 });
    expect(reply.json.applied).toHaveLength(1);
  });

  it("the second run with nothing changed is skipped and makes no model call", async () => {
    await seedTabs(ALICE, tabs([...TRIP, ...CODE, ONE_OFF]));
    const model = twoGroups();
    const first = await run(ALICE);
    expect(model.calls).toHaveLength(1);

    const second = await run(ALICE);
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ skipped: true, reason: "unchanged", applied: [], suggestions: [] });
    expect(second.json.run.id).toBe(first.json.run.id);
    expect(model.calls).toHaveLength(1);
    expect(await count("SELECT count(*)::int AS n FROM cluster_runs")).toBe(1); // the guard row is removed again
  });

  it("force runs again, and does not duplicate the workspaces it already made", async () => {
    await seedTabs(ALICE, tabs([...TRIP, ...CODE, ONE_OFF]));
    const model = twoGroups();
    await run(ALICE);
    const forced = await run(ALICE, { force: true });
    expect(forced.json.skipped).toBe(false);
    // only the one-off is left unplaced, so there is nothing to group and no model call
    expect(forced.json.applied).toEqual([]);
    expect(model.calls).toHaveLength(1);
    expect(await count("SELECT count(*)::int AS n FROM workspaces")).toBe(2);
  });

  it("runs again when a new unplaced tab arrives", async () => {
    await seedTabs(ALICE, tabs([...TRIP, ONE_OFF]));
    const model = twoGroups();
    await run(ALICE);
    await seedTabs(ALICE, tabs(["https://code.example/new-a", "https://code.example/new-b"]));
    const again = await run(ALICE);
    expect(again.json.skipped).toBe(false);
    expect(model.calls).toHaveLength(2);
  });

  it("a tab the user places while the model is thinking is not moved (the user wins)", async () => {
    const stored = await seedTabs(ALICE, tabs(TRIP));
    await pair(ALICE);
    const mine = await makeWorkspace(ALICE, "Mine");
    installFakeModel(async (input) => {
      // the user drags one of these tabs somewhere while the model is still answering
      await read(tabRefsPut(req("PUT", "/api/tab-refs", ALICE, { url: TRIP[1], workspaceId: mine.id })));
      return [group("Kyoto trip", idsFor(input, "trip.example"))];
    });
    const reply = await run(ALICE);
    expect(reply.json.run.appliedCount).toBe(2);
    const after = await listTabs(ALICE);
    expect(after.find((t) => t.url === TRIP[1])).toMatchObject({ workspaceId: mine.id, placementSource: "user" });
    expect(after.filter((t) => t.placementSource === "ai")).toHaveLength(2);
    expect(stored).toHaveLength(3);
  });

  it("a group left with fewer than two movable tabs is rolled back: no orphan workspace", async () => {
    await seedTabs(ALICE, tabs(TRIP.slice(0, 2)));
    await pair(ALICE);
    const mine = await makeWorkspace(ALICE, "Mine");
    installFakeModel(async (input) => {
      await read(tabRefsPut(req("PUT", "/api/tab-refs", ALICE, { url: TRIP[0], workspaceId: mine.id })));
      return [group("Kyoto trip", idsFor(input, "trip.example"))];
    });
    const reply = await run(ALICE);
    expect(reply.status).toBe(200);
    expect(reply.json.applied).toEqual([]);
    expect(reply.json.run.appliedCount).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM workspaces WHERE name = 'Kyoto trip'")).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM cluster_run_moves")).toBe(0);
  });
});

describe("failures change nothing (FR-013, SC-007)", () => {
  const snapshot = async () => ({
    tabs: JSON.stringify(await listTabs(ALICE)),
    workspaces: await count("SELECT count(*)::int AS n FROM workspaces"),
    moves: await count("SELECT count(*)::int AS n FROM cluster_run_moves"),
  });

  it("a model error is a 502, the run is recorded as failed, and nothing else changes", async () => {
    await seedTabs(ALICE, tabs([...TRIP, ...CODE]));
    const before = await snapshot();
    installFakeModel(() => {
      throw new ModelError("The AI service did not respond in time.");
    });
    const reply = await run(ALICE);
    expect(reply.status).toBe(502);
    expect(reply.json).toMatchObject({ code: "model_error", error: "The AI service did not respond in time." });
    expect(reply.json.runId).toBeTruthy();
    expect(await snapshot()).toEqual(before);
    const stored = (await runsList(ALICE)).json.runs;
    expect(stored[0]).toMatchObject({ id: reply.json.runId, status: "failed", error: "The AI service did not respond in time." });
  });

  it("a model that returns something the wrong shape fails the run without changing anything", async () => {
    await seedTabs(ALICE, tabs([...TRIP, ...CODE]));
    const before = await snapshot();
    installFakeModel(() => "not an array" as unknown as unknown[]);
    const reply = await run(ALICE);
    expect(reply.status).toBe(502);
    expect(await snapshot()).toEqual(before);
  });

  it("a spent daily budget is a 429 budget_exhausted; nothing changes", async () => {
    await seedTabs(ALICE, tabs([...TRIP, ...CODE]));
    const before = await snapshot();
    installFakeModel(() => {
      throw new BudgetExceededError();
    });
    const reply = await run(ALICE);
    expect(reply.status).toBe(429);
    expect(reply.json).toMatchObject({ code: "budget_exhausted" });
    expect(await snapshot()).toEqual(before);
    expect((await runsList(ALICE)).json.runs[0].status).toBe("failed");
  });

  it("LLM_DAILY_CAP stops a second real request: the first run works, the forced second is a 429", async () => {
    process.env.LLM_DAILY_CAP = "1";
    await seedTabs(ALICE, tabs([...TRIP, ...CODE]));
    installFakeModel((input) => {
      spend("cluster"); // what the real client does immediately before each request
      return [group("Kyoto trip", idsFor(input, "trip.example"))];
    });
    expect((await run(ALICE)).status).toBe(200);
    await seedTabs(ALICE, tabs(["https://more.example/a", "https://more.example/b"]));
    const second = await run(ALICE);
    expect(second.status).toBe(429);
    expect(second.json.code).toBe("budget_exhausted");
  });

  it("no model key (the default in tests) is a 503 and no run is recorded", async () => {
    await seedTabs(ALICE, tabs([...TRIP, ...CODE]));
    const reply = await run(ALICE); // no fake installed, GEMINI_API_KEY is blank in tests
    expect(reply.status).toBe(503);
    expect(reply.json.code).toBe("model_unconfigured");
    expect(await count("SELECT count(*)::int AS n FROM cluster_runs")).toBe(0);
  });

  it("an unexpected bug is a 500 whose message says nothing about the cause", async () => {
    await seedTabs(ALICE, tabs([...TRIP, ...CODE]));
    installFakeModel(() => {
      throw new Error("select * from secrets where token = 'hunter2'");
    });
    const reply = await run(ALICE);
    expect(reply.status).toBe(500);
    expect(JSON.stringify(reply.json)).not.toContain("hunter2");
    const stored = (await runsList(ALICE)).json.runs[0];
    expect(stored.status).toBe("failed");
    expect(stored.error).not.toContain("hunter2");
  });
});

describe("one run at a time, and auth", () => {
  it("rejects a request with no token (401)", async () => {
    expect((await run(null)).status).toBe(401);
    expect((await read(runsGet(req("GET", "/api/cluster/runs", null)))).status).toBe(401);
  });

  it("rejects a body that is not a JSON object, or a non-boolean force (400)", async () => {
    await pair(ALICE);
    installFakeModel(() => []);
    expect((await run(ALICE, [1, 2])).status).toBe(400);
    expect((await run(ALICE, "text")).status).toBe(400);
    expect((await run(ALICE, { force: "yes" })).status).toBe(400);
    const bad = new Request("http://localhost/api/cluster/runs", {
      method: "POST",
      headers: { authorization: `Bearer ${ALICE}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect((await read(runsPost(bad))).status).toBe(400);
  });

  it("two overlapping runs: one succeeds, the other is a 409", async () => {
    await seedTabs(ALICE, tabs([...TRIP, ...CODE]));
    const held = gate();
    installFakeModel(async (input) => {
      await held.wait;
      return [group("Kyoto trip", idsFor(input, "trip.example"))];
    });
    const first = run(ALICE);
    // wait until the first run has taken the guard
    for (let i = 0; i < 100 && (await count("SELECT count(*)::int AS n FROM cluster_runs WHERE status = 'running'")) === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const second = await run(ALICE);
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("run_in_progress");
    held.release();
    expect((await first).status).toBe(200);
    expect(await count("SELECT count(*)::int AS n FROM cluster_runs WHERE status = 'running'")).toBe(0);
  });

  it("a run left `running` for over 120 seconds is treated as crashed and does not block a new one", async () => {
    await seedTabs(ALICE, tabs([...TRIP, ...CODE]));
    const userId = (await pair(ALICE)).json.userId;
    await query(
      `INSERT INTO cluster_runs (id, user_id, status, started_at) VALUES ($1, $2, 'running', now() - interval '5 minutes')`,
      [crypto.randomUUID(), userId],
    );
    twoGroups();
    expect((await run(ALICE)).status).toBe(200);
    const runs = (await runsList(ALICE)).json.runs;
    expect(runs.map((r: { status: string }) => r.status).sort()).toEqual(["failed", "succeeded"]);
    expect(runs.find((r: { status: string }) => r.status === "failed").error).toContain("timed out");
  });

  it("lists this user's runs newest first and honours limit", async () => {
    await seedTabs(ALICE, tabs([...TRIP, ...CODE]));
    twoGroups();
    await run(ALICE);
    await seedTabs(ALICE, tabs(["https://x.example/a", "https://x.example/b"]));
    await run(ALICE, { force: true });
    const all = (await runsList(ALICE)).json.runs;
    expect(all).toHaveLength(2);
    expect(new Date(all[0].startedAt).getTime()).toBeGreaterThanOrEqual(new Date(all[1].startedAt).getTime());
    expect((await runsList(ALICE, "?limit=1")).json.runs).toHaveLength(1);
  });
});

describe("isolation between users (FR-017, SC-008)", () => {
  it("one user's tabs never reach another user's model call, and never change", async () => {
    await seedTabs(ALICE, tabs([...TRIP, ...CODE]));
    await seedTabs(BOB, tabs(["https://bob.example/one", "https://bob.example/two"]));
    const model = installFakeModel((input) => [group("Bob's things", idsFor(input, "bob.example"))]);

    const reply = await run(BOB);
    expect(reply.status).toBe(200);
    expect(model.calls).toHaveLength(1);
    expect(JSON.stringify(model.calls[0])).not.toContain("trip.example");
    expect(JSON.stringify(model.calls[0])).not.toContain("code.example");

    // Alice's tabs are untouched, and Alice sees none of Bob's runs
    expect((await listTabs(ALICE)).every((t) => t.workspaceId === null && t.placementSource === null)).toBe(true);
    expect((await runsList(ALICE)).json.runs).toEqual([]);
    expect((await runsList(BOB)).json.runs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("user story 2: uncertain groups become suggestions", () => {
  const UNSURE = 0.6; // below the default bar of 0.7

  /** Three trip tabs and a model that is not sure about them. */
  async function unsureTrip(confidence = UNSURE) {
    await seedTabs(ALICE, tabs(TRIP));
    return installFakeModel((input) => [group("Kyoto trip", idsFor(input, "trip.example"), confidence, { emoji: "🗾" })]);
  }

  it("a group below the bar becomes a pending suggestion and moves nothing", async () => {
    await unsureTrip();
    const reply = await run(ALICE);
    expect(reply.status).toBe(200);
    expect(reply.json.applied).toEqual([]);
    expect(reply.json.run).toMatchObject({ status: "succeeded", appliedCount: 0, suggestionCount: 1 });
    expect(reply.json.suggestions).toHaveLength(1);
    expect(reply.json.suggestions[0]).toMatchObject({ name: "Kyoto trip", emoji: "🗾", status: "pending", confidence: UNSURE });
    expect(reply.json.suggestions[0].tabRefs.map((t: { url: string }) => t.url).sort()).toEqual([...TRIP].sort());

    // nothing moved, nothing created
    expect((await listTabs(ALICE)).every((t) => t.workspaceId === null && t.placementSource === null)).toBe(true);
    expect(await count("SELECT count(*)::int AS n FROM workspaces")).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM cluster_run_moves")).toBe(0);
  });

  it("one run can apply a confident group and suggest an unsure one", async () => {
    await seedTabs(ALICE, tabs([...TRIP, ...CODE]));
    installFakeModel((input) => [group("Kyoto trip", idsFor(input, "trip.example"), 0.95), group("Coding", idsFor(input, "code.example"), 0.6)]);
    const reply = await run(ALICE);
    expect(reply.json.applied.map((a: { workspace: { name: string } }) => a.workspace.name)).toEqual(["Kyoto trip"]);
    expect(reply.json.suggestions.map((s: { name: string }) => s.name)).toEqual(["Coding"]);
    expect(reply.json.run).toMatchObject({ appliedCount: 3, suggestionCount: 1 });
  });

  it("the same unsure group on a later run refreshes its suggestion instead of duplicating it", async () => {
    await unsureTrip();
    const first = await run(ALICE);
    const again = await run(ALICE, { force: true });
    expect(again.json.suggestions).toHaveLength(1);
    expect(again.json.suggestions[0].id).toBe(first.json.suggestions[0].id);
    expect(again.json.suggestions[0].runId).toBe(again.json.run.id); // refreshed by the newer run
    expect(await count("SELECT count(*)::int AS n FROM suggestions")).toBe(1);
  });

  it("a pending suggestion is superseded when the group later comes back confident and is applied", async () => {
    await unsureTrip(0.6);
    const first = await run(ALICE);
    const model = installFakeModel((input) => [group("Kyoto trip", idsFor(input, "trip.example"), 0.95)]);
    const second = await run(ALICE, { force: true });
    expect(model.calls).toHaveLength(1);
    expect(second.json.applied).toHaveLength(1);
    const all = (await suggestionList(ALICE, "?status=all")).json.suggestions;
    expect(all.find((s: { id: string }) => s.id === first.json.suggestions[0].id).status).toBe("withdrawn");
    expect((await suggestionList(ALICE)).json.suggestions).toEqual([]);
  });

  it("ignoring removes it from the pending list, and the same group is not suggested again", async () => {
    await unsureTrip();
    const first = await run(ALICE);
    const id = first.json.suggestions[0].id;
    const ignored = await ignore(ALICE, id);
    expect(ignored.status).toBe(200);
    expect(ignored.json.suggestion).toMatchObject({ id, status: "ignored" });
    expect(ignored.json.suggestion.resolvedAt).toBeTruthy();
    expect((await suggestionList(ALICE)).json.suggestions).toEqual([]);

    const again = await run(ALICE, { force: true });
    expect(again.json.suggestions).toEqual([]);
    expect((await suggestionList(ALICE)).json.suggestions).toEqual([]);
    expect(await count("SELECT count(*)::int AS n FROM suggestions")).toBe(1);
  });

  it("an ignored group is not auto-applied either, even when the model is now confident (analysis finding U1)", async () => {
    await unsureTrip(0.6);
    const first = await run(ALICE);
    await ignore(ALICE, first.json.suggestions[0].id);

    installFakeModel((input) => [group("Kyoto trip", idsFor(input, "trip.example"), 0.99)]);
    const again = await run(ALICE, { force: true });
    expect(again.status).toBe(200);
    expect(again.json.applied).toEqual([]);
    expect(again.json.suggestions).toEqual([]);
    expect(await count("SELECT count(*)::int AS n FROM workspaces")).toBe(0);
    expect((await listTabs(ALICE)).every((t) => t.workspaceId === null)).toBe(true);
  });

  it("a group whose tabs materially changed is offered again", async () => {
    await unsureTrip();
    const first = await run(ALICE);
    await ignore(ALICE, first.json.suggestions[0].id);

    // two of the old tabs plus four new ones: far below 70% overlap with the dismissed group
    await seedTabs(ALICE, tabs(["https://trip.example/new-1", "https://trip.example/new-2", "https://trip.example/new-3", "https://trip.example/new-4"]));
    installFakeModel((input) => [group("Kyoto trip", idsFor(input, "kyoto-flights", "kyoto-hotels", "new-"), 0.6)]);
    const again = await run(ALICE);
    expect(again.json.suggestions).toHaveLength(1);
    expect(again.json.suggestions[0].id).not.toBe(first.json.suggestions[0].id);
  });

  it("GET /api/suggestions lists only pending ones by default, and rejects an unknown status", async () => {
    await unsureTrip();
    const first = await run(ALICE);
    expect((await suggestionList(ALICE)).json.suggestions).toHaveLength(1);
    await ignore(ALICE, first.json.suggestions[0].id);
    expect((await suggestionList(ALICE, "?status=ignored")).json.suggestions).toHaveLength(1);
    expect((await suggestionList(ALICE, "?status=all")).json.suggestions).toHaveLength(1);
    expect((await suggestionList(ALICE, "?status=pending")).json.suggestions).toHaveLength(0);
    expect((await suggestionList(ALICE, "?status=bogus")).status).toBe(400);
  });

  it("a pending suggestion only shows its tabs that are still unplaced, and is withdrawn when fewer than two remain", async () => {
    await unsureTrip();
    const first = await run(ALICE);
    await pair(ALICE);
    const mine = await makeWorkspace(ALICE, "Mine");

    // the user files one tab elsewhere: two remain, so it is still offered, with two tabs
    await read(tabRefsPut(req("PUT", "/api/tab-refs", ALICE, { url: TRIP[0], workspaceId: mine.id })));
    const two = (await suggestionList(ALICE)).json.suggestions;
    expect(two).toHaveLength(1);
    expect(two[0].tabRefs.map((t: { url: string }) => t.url).sort()).toEqual([TRIP[1], TRIP[2]].sort());

    // and another: one remains, which is too few, so it is withdrawn
    await read(tabRefsPut(req("PUT", "/api/tab-refs", ALICE, { url: TRIP[1], workspaceId: mine.id })));
    expect((await suggestionList(ALICE)).json.suggestions).toEqual([]);
    const all = (await suggestionList(ALICE, "?status=all")).json.suggestions;
    expect(all.find((s: { id: string }) => s.id === first.json.suggestions[0].id).status).toBe("withdrawn");
  });

  it("accepting creates the workspace and assigns the tabs as the user's own placement", async () => {
    await unsureTrip();
    const first = await run(ALICE);
    const id = first.json.suggestions[0].id;

    const reply = await accept(ALICE, id);
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ created: true, suggestion: { id, status: "accepted" } });
    expect(reply.json.workspace).toMatchObject({ name: "Kyoto trip", emoji: "🗾", status: "active" });
    expect(reply.json.tabRefs).toHaveLength(3);
    expect(reply.json.tabRefs.every((t: { placementSource: string; workspaceId: string }) => t.placementSource === "user" && t.workspaceId === reply.json.workspace.id)).toBe(true);

    expect((await listTabs(ALICE)).every((t) => t.placementSource === "user")).toBe(true);
    expect(await count("SELECT count(*)::int AS n FROM tab_events WHERE event_type = 'reassigned'")).toBe(3);
    // an accepted suggestion is the user's placement, not part of the run, so it is not in the run's undo log
    expect(await count("SELECT count(*)::int AS n FROM cluster_run_moves")).toBe(0);
    expect((await suggestionList(ALICE)).json.suggestions).toEqual([]);
  });

  it("accepting twice, or accepting an ignored suggestion, is a 409 not_pending", async () => {
    await unsureTrip();
    const first = await run(ALICE);
    const id = first.json.suggestions[0].id;
    expect((await accept(ALICE, id)).status).toBe(200);
    const twice = await accept(ALICE, id);
    expect(twice.status).toBe(409);
    expect(twice.json.code).toBe("not_pending");
    expect((await ignore(ALICE, id)).status).toBe(409); // ignoring an accepted one too
  });

  it("accepting a stale suggestion is a 409 stale and withdraws it", async () => {
    await unsureTrip();
    const first = await run(ALICE);
    const id = first.json.suggestions[0].id;
    await pair(ALICE);
    const mine = await makeWorkspace(ALICE, "Mine");
    for (const url of [TRIP[0], TRIP[1]]) await read(tabRefsPut(req("PUT", "/api/tab-refs", ALICE, { url, workspaceId: mine.id })));

    const reply = await accept(ALICE, id);
    expect(reply.status).toBe(409);
    expect(reply.json.code).toBe("stale");
    const all = (await suggestionList(ALICE, "?status=all")).json.suggestions;
    expect(all.find((s: { id: string }) => s.id === id).status).toBe("withdrawn");
    // the one tab that was left is untouched
    expect((await listTabs(ALICE)).find((t) => t.url === TRIP[2])).toMatchObject({ workspaceId: null, placementSource: null });
  });

  it("ignoring an already ignored suggestion is a 200 no-op", async () => {
    await unsureTrip();
    const id = (await run(ALICE)).json.suggestions[0].id;
    expect((await ignore(ALICE, id)).status).toBe(200);
    const again = await ignore(ALICE, id);
    expect(again.status).toBe(200);
    expect(again.json.suggestion.status).toBe("ignored");
  });

  it("another user's suggestion is a 404 to read-through, accept, and ignore", async () => {
    await unsureTrip();
    const id = (await run(ALICE)).json.suggestions[0].id;
    await pair(BOB);
    expect((await accept(BOB, id)).status).toBe(404);
    expect((await ignore(BOB, id)).status).toBe(404);
    expect((await suggestionList(BOB)).json.suggestions).toEqual([]);
    expect((await accept(ALICE, crypto.randomUUID())).status).toBe(404);
    // and nothing happened to Alice's
    expect((await suggestionList(ALICE)).json.suggestions).toHaveLength(1);
  });

  it("requires a token on every suggestion route (401)", async () => {
    expect((await suggestionList(null as unknown as string)).status).toBe(401);
    expect((await read(acceptPost(req("POST", "/x", null), ctx(crypto.randomUUID())))).status).toBe(401);
    expect((await read(ignorePost(req("POST", "/x", null), ctx(crypto.randomUUID())))).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe("user story 3: existing workspaces and Other are respected", () => {
  const archive = (token: string, id: string) => read(workspacePatch(req("PATCH", "/x", token, { status: "archived" }), ctx(id)));
  const workspaces = async () => (await query<{ id: string; name: string; status: string }>("SELECT id, name, status FROM workspaces ORDER BY created_at")).rows;

  async function withJapan() {
    await seedTabs(ALICE, tabs(TRIP));
    await pair(ALICE);
    return makeWorkspace(ALICE, "Trip to Japan", "🗾");
  }

  it("a group that names an existing workspace's id joins it: no second workspace, and it is not a created one", async () => {
    const japan = await withJapan();
    installFakeModel((input) => [group("Japan travel", idsFor(input, "trip.example"), 0.95, { existingWorkspaceId: japan.id })]);
    const reply = await run(ALICE);

    expect(reply.json.applied).toHaveLength(1);
    expect(reply.json.applied[0]).toMatchObject({ created: false, workspace: { id: japan.id, name: "Trip to Japan" } });
    expect(reply.json.run).toMatchObject({ appliedCount: 3, createdWorkspaceIds: [] });
    expect((await listTabs(ALICE)).every((t) => t.workspaceId === japan.id && t.placementSource === "ai")).toBe(true);
    expect((await workspaces()).map((w) => w.name)).toEqual(["Trip to Japan"]);
    expect(reply.json.applied[0].workspace.updatedAt).toBe(japan.updatedAt); // joining does not touch the workspace
  });

  it("tells the model about the existing workspaces (id and name only)", async () => {
    const japan = await withJapan();
    const model = installFakeModel(() => []);
    await run(ALICE);
    expect(model.calls[0].workspaces).toEqual([{ id: japan.id, name: "Trip to Japan" }]);
  });

  it("a new name that matches an active workspace's name (any case) joins it instead of duplicating it", async () => {
    const japan = await withJapan();
    installFakeModel((input) => [group("  trip TO japan ", idsFor(input, "trip.example"), 0.95)]);
    const reply = await run(ALICE);
    expect(reply.json.applied[0]).toMatchObject({ created: false, workspace: { id: japan.id } });
    expect((await workspaces()).map((w) => w.name)).toEqual(["Trip to Japan"]);
  });

  it("two groups with the same new name in one answer become one workspace", async () => {
    await seedTabs(ALICE, tabs([...TRIP, ...CODE]));
    installFakeModel((input) => [
      group("Side project", idsFor(input, "trip.example"), 0.95),
      group("Side project", idsFor(input, "code.example"), 0.9),
    ]);
    const reply = await run(ALICE);
    expect((await workspaces()).map((w) => w.name)).toEqual(["Side project"]);
    expect(reply.json.applied.map((a: { created: boolean }) => a.created)).toEqual([true, false]);
    expect(reply.json.run.createdWorkspaceIds).toHaveLength(1);
    expect((await listTabs(ALICE)).every((t) => t.workspaceId === reply.json.applied[0].workspace.id)).toBe(true);
  });

  it("never offers or targets an archived workspace, even one with the same name", async () => {
    const japan = await withJapan();
    await archive(ALICE, japan.id);
    const model = installFakeModel((input) => [
      group("Trip to Japan", idsFor(input, "trip.example"), 0.95, { existingWorkspaceId: japan.id }), // the model insists
    ]);
    const reply = await run(ALICE);

    expect(model.calls[0].workspaces).toEqual([]); // archived ones are not even mentioned
    expect(reply.json.applied[0].created).toBe(true); // a fresh workspace, not the archived one
    expect(reply.json.applied[0].workspace.id).not.toBe(japan.id);
    const all = await workspaces();
    expect(all.find((w) => w.id === japan.id)?.status).toBe("archived");
    expect((await listTabs(ALICE)).some((t) => t.workspaceId === japan.id)).toBe(false);
  });

  it("a group called Other creates nothing and is counted as discarded", async () => {
    await seedTabs(ALICE, tabs(TRIP));
    installFakeModel((input) => [group("Other", idsFor(input, "trip.example"), 0.99)]);
    const reply = await run(ALICE);
    expect(reply.json.applied).toEqual([]);
    expect(reply.json.run.discardedCount).toBe(1);
    expect(await workspaces()).toEqual([]);
    expect((await listTabs(ALICE)).every((t) => t.workspaceId === null)).toBe(true);
  });

  it("a tab the user placed, or deliberately left in Other, is never in the model's input and never moves", async () => {
    await pair(ALICE);
    const mine = await makeWorkspace(ALICE, "Mine");
    await seedTabs(ALICE, tabs(["https://placed.example/a", "https://kept.example/b"]));
    await read(tabRefsPut(req("PUT", "/api/tab-refs", ALICE, { url: "https://placed.example/a", workspaceId: mine.id })));
    await read(tabRefsPut(req("PUT", "/api/tab-refs", ALICE, { url: "https://kept.example/b", workspaceId: null })));

    // SC-003: five runs in a row, new tabs arriving between them, and a model that would
    // happily group everything it is shown
    const model = installFakeModel((input) => [group("Everything", input.tabs.map((t) => t.id), 0.95)]);
    for (let round = 0; round < 5; round += 1) {
      await seedTabs(ALICE, tabs([`https://new.example/r${round}-a`, `https://new.example/r${round}-b`]));
      const reply = await run(ALICE);
      expect(reply.status).toBe(200);
    }

    for (const call of model.calls) {
      const urls = call.tabs.map((t) => t.url);
      expect(urls).not.toContain("https://placed.example/a");
      expect(urls).not.toContain("https://kept.example/b");
    }
    const after = await listTabs(ALICE);
    expect(after.find((t) => t.url === "https://placed.example/a")).toMatchObject({ workspaceId: mine.id, placementSource: "user" });
    expect(after.find((t) => t.url === "https://kept.example/b")).toMatchObject({ workspaceId: null, placementSource: "user" });
  });

  it("a suggestion for an existing workspace records it, and accepting joins that workspace", async () => {
    const japan = await withJapan();
    installFakeModel((input) => [group("Japan travel", idsFor(input, "trip.example"), 0.6, { existingWorkspaceId: japan.id })]);
    const first = await run(ALICE);
    expect(first.json.suggestions[0]).toMatchObject({ targetWorkspaceId: japan.id, targetWorkspace: { id: japan.id, name: "Trip to Japan" } });

    const reply = await accept(ALICE, first.json.suggestions[0].id);
    expect(reply.json).toMatchObject({ created: false, workspace: { id: japan.id } });
    expect(reply.json.tabRefs.every((t: { workspaceId: string }) => t.workspaceId === japan.id)).toBe(true);
    expect((await workspaces()).map((w) => w.name)).toEqual(["Trip to Japan"]);
  });

  it("a suggestion whose name matches an active workspace targets it, and accepting does not duplicate it", async () => {
    const japan = await withJapan();
    installFakeModel((input) => [group("trip to japan", idsFor(input, "trip.example"), 0.6)]);
    const first = await run(ALICE);
    expect(first.json.suggestions[0].targetWorkspaceId).toBe(japan.id);
    expect((await accept(ALICE, first.json.suggestions[0].id)).json.created).toBe(false);
    expect((await workspaces()).map((w) => w.name)).toEqual(["Trip to Japan"]);
  });

  it("a suggestion never targets an archived workspace, including one archived after it was made", async () => {
    const japan = await withJapan();
    await archive(ALICE, japan.id);
    installFakeModel((input) => [group("Trip to Japan", idsFor(input, "trip.example"), 0.6, { existingWorkspaceId: japan.id })]);
    const first = await run(ALICE);
    expect(first.json.suggestions[0].targetWorkspaceId).toBeNull(); // the archived id was refused

    // archived after the suggestion was made: accepting must not resurrect it
    await pair(ALICE);
    const later = await makeWorkspace(ALICE, "Later");
    installFakeModel((input) => [group("Later stuff", idsFor(input, "trip.example"), 0.6, { existingWorkspaceId: later.id })]);
    await run(ALICE, { force: true });
    await archive(ALICE, later.id);
    const pending = (await suggestionList(ALICE)).json.suggestions.find((s: { targetWorkspaceId: string | null }) => s.targetWorkspaceId === later.id);
    const reply = await accept(ALICE, pending.id);
    expect(reply.json.created).toBe(true);
    expect(reply.json.workspace.id).not.toBe(later.id);
  });
});

// ---------------------------------------------------------------------------
describe("user story 4: AI grouping is always reversible", () => {
  const undo = (token: string, id: string) => read(undoPost(req("POST", "/x", token), ctx(id)));
  const runDetail = (token: string, id: string) => read(runGet(req("GET", "/x", token), ctx(id)));
  const patchTab = (token: string, id: string, body: unknown) => read(tabRefPatch(req("PATCH", "/x", token, body), ctx(id)));
  const rename = (token: string, id: string, name: string) => read(workspacePatch(req("PATCH", "/x", token, { name }), ctx(id)));
  const workspaceRows = async () => (await query<{ id: string; name: string; status: string }>("SELECT id, name, status FROM workspaces ORDER BY created_at")).rows;
  const corrections = async () => (await query<{ from_workspace_id: string | null; to_workspace_id: string | null; tab_ref_id: string; url: string }>("SELECT from_workspace_id, to_workspace_id, tab_ref_id, url FROM corrections")).rows;

  /** A run that made two workspaces (trip, coding) out of five tabs. */
  async function appliedRun() {
    await seedTabs(ALICE, tabs([...TRIP, ...CODE, ONE_OFF]));
    twoGroups();
    const reply = await run(ALICE);
    const byName = (name: string) => reply.json.applied.find((a: { workspace: { name: string } }) => a.workspace.name === name);
    return { reply, runId: reply.json.run.id as string, kyoto: byName("Kyoto trip").workspace, coding: byName("Coding project").workspace };
  }

  it("undoing a run puts every tab it moved back in Other, unplaced, and records the undo", async () => {
    const { runId } = await appliedRun();
    const reply = await undo(ALICE, runId);
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ reverted: 5, keptTabRefIds: [] });
    expect(reply.json.run).toMatchObject({ id: runId, status: "undone" });
    expect(reply.json.run.undoneAt).toBeTruthy();

    expect((await listTabs(ALICE)).every((t) => t.workspaceId === null && t.placementSource === null)).toBe(true);
    // 5 reassignments when applied, and 5 more when reverted (to Other)
    expect(await count("SELECT count(*)::int AS n FROM tab_events WHERE event_type = 'reassigned'")).toBe(10);
    expect(await count("SELECT count(*)::int AS n FROM tab_events WHERE event_type = 'reassigned' AND workspace_id IS NULL")).toBe(5);
  });

  it("archives the workspaces the run created when they are empty and untouched", async () => {
    const { runId, kyoto, coding } = await appliedRun();
    const reply = await undo(ALICE, runId);
    expect([...reply.json.archivedWorkspaceIds].sort()).toEqual([kyoto.id, coding.id].sort());
    expect((await workspaceRows()).every((w) => w.status === "archived")).toBe(true);
    expect(await workspaceRows()).toHaveLength(2); // archived, not deleted
  });

  it("keeps a workspace the user renamed, and one the user added a tab to", async () => {
    const { runId, kyoto, coding } = await appliedRun();
    await rename(ALICE, kyoto.id, "My Kyoto plans");
    await seedTabs(ALICE, tabs(["https://mine.example/notes"]));
    await read(tabRefsPut(req("PUT", "/api/tab-refs", ALICE, { url: "https://mine.example/notes", workspaceId: coding.id })));

    const reply = await undo(ALICE, runId);
    expect(reply.json.archivedWorkspaceIds).toEqual([]);
    expect(reply.json.reverted).toBe(5);
    const rows = await workspaceRows();
    expect(rows.find((w) => w.id === kyoto.id)).toMatchObject({ name: "My Kyoto plans", status: "active" });
    expect(rows.find((w) => w.id === coding.id)?.status).toBe("active");
    // the user's own tab is still where they put it
    expect((await listTabs(ALICE)).find((t) => t.url === "https://mine.example/notes")).toMatchObject({ workspaceId: coding.id, placementSource: "user" });
  });

  it("does not touch a tab the user moved since: it stays put and is reported as kept", async () => {
    const { runId } = await appliedRun();
    await pair(ALICE);
    const mine = await makeWorkspace(ALICE, "Mine");
    const moved = (await listTabs(ALICE)).find((t) => t.url === TRIP[0])!;
    await patchTab(ALICE, moved.id, { workspaceId: mine.id });

    const reply = await undo(ALICE, runId);
    expect(reply.json.reverted).toBe(4);
    expect(reply.json.keptTabRefIds).toEqual([moved.id]);
    expect((await listTabs(ALICE)).find((t) => t.id === moved.id)).toMatchObject({ workspaceId: mine.id, placementSource: "user" });
  });

  it("undoing joins-to-an-existing-workspace puts the tabs back and leaves that workspace alone", async () => {
    await seedTabs(ALICE, tabs(TRIP));
    await pair(ALICE);
    const japan = await makeWorkspace(ALICE, "Trip to Japan");
    installFakeModel((input) => [group("Japan", idsFor(input, "trip.example"), 0.95, { existingWorkspaceId: japan.id })]);
    const runId = (await run(ALICE)).json.run.id;

    const reply = await undo(ALICE, runId);
    expect(reply.json).toMatchObject({ reverted: 3, archivedWorkspaceIds: [] });
    expect((await workspaceRows()).find((w) => w.id === japan.id)?.status).toBe("active");
    expect((await listTabs(ALICE)).every((t) => t.workspaceId === null && t.placementSource === null)).toBe(true);
  });

  it("undoing an already undone run is a 200 that reverts nothing", async () => {
    const { runId } = await appliedRun();
    await undo(ALICE, runId);
    const again = await undo(ALICE, runId);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ reverted: 0, keptTabRefIds: [], archivedWorkspaceIds: [] });
    expect(again.json.run.status).toBe("undone");
  });

  it("a run that is running or failed cannot be undone (409 not_undoable)", async () => {
    await seedTabs(ALICE, tabs([...TRIP, ...CODE]));
    installFakeModel(() => {
      throw new ModelError();
    });
    const failed = (await run(ALICE)).json.runId;
    const bad = await undo(ALICE, failed);
    expect(bad.status).toBe(409);
    expect(bad.json.code).toBe("not_undoable");

    const userId = (await pair(ALICE)).json.userId;
    const runningId = crypto.randomUUID();
    await query(`INSERT INTO cluster_runs (id, user_id, status) VALUES ($1, $2, 'running')`, [runningId, userId]);
    expect((await undo(ALICE, runningId)).status).toBe(409);
  });

  it("after an undo, a run with nothing new is skipped instead of redoing what the user undid", async () => {
    const { runId } = await appliedRun();
    await undo(ALICE, runId);
    const model = twoGroups();
    const again = await run(ALICE);
    expect(again.json.skipped).toBe(true);
    expect(model.calls).toHaveLength(0);
    // but the user can still ask on purpose
    expect((await run(ALICE, { force: true })).json.skipped).toBe(false);
    expect(model.calls).toHaveLength(1);
  });

  it("moving an AI-placed tab makes it the user's, records one correction, and later runs leave it alone", async () => {
    const { kyoto } = await appliedRun();
    await pair(ALICE);
    const mine = await makeWorkspace(ALICE, "Mine");
    const tab0 = (await listTabs(ALICE)).find((t) => t.url === TRIP[0])!;

    const moved = await patchTab(ALICE, tab0.id, { workspaceId: mine.id });
    expect(moved.json.tabRef).toMatchObject({ workspaceId: mine.id, placementSource: "user" });
    expect(await corrections()).toEqual([{ from_workspace_id: kyoto.id, to_workspace_id: mine.id, tab_ref_id: tab0.id, url: TRIP[0] }]);

    // and to Other by PUT: the tab is now the user's, so a second move is not an AI correction
    await read(tabRefsPut(req("PUT", "/api/tab-refs", ALICE, { url: TRIP[0], workspaceId: null })));
    expect(await corrections()).toHaveLength(1);

    // a later run, even forced, with new tabs, does not move it
    await seedTabs(ALICE, tabs(["https://trip.example/new-a", "https://trip.example/new-b"]));
    installFakeModel((input) => [group("More travel", input.tabs.map((t) => t.id), 0.95)]);
    await run(ALICE, { force: true });
    expect((await listTabs(ALICE)).find((t) => t.id === tab0.id)).toMatchObject({ workspaceId: null, placementSource: "user" });
  });

  it("moving an AI-placed tab through PUT records the correction too, and moving it nowhere new records none", async () => {
    const { kyoto, coding } = await appliedRun();
    const tab0 = (await listTabs(ALICE)).find((t) => t.url === TRIP[0])!;
    // same workspace it is already in: the user confirms it, but nothing moved, so no correction
    await read(tabRefsPut(req("PUT", "/api/tab-refs", ALICE, { url: TRIP[0], workspaceId: kyoto.id })));
    expect(await corrections()).toEqual([]);
    expect((await listTabs(ALICE)).find((t) => t.id === tab0.id)?.placementSource).toBe("user");

    const tab1 = (await listTabs(ALICE)).find((t) => t.url === TRIP[1])!;
    await read(tabRefsPut(req("PUT", "/api/tab-refs", ALICE, { url: TRIP[1], workspaceId: coding.id })));
    expect(await corrections()).toEqual([{ from_workspace_id: kyoto.id, to_workspace_id: coding.id, tab_ref_id: tab1.id, url: TRIP[1] }]);
  });

  it("moving a tab that was never AI-placed records no correction", async () => {
    await seedTabs(ALICE, tabs(["https://a.example/1"]));
    await pair(ALICE);
    const mine = await makeWorkspace(ALICE, "Mine");
    const id = (await listTabs(ALICE))[0].id;
    await patchTab(ALICE, id, { workspaceId: mine.id });
    await patchTab(ALICE, id, { workspaceId: null });
    expect(await corrections()).toEqual([]);
  });

  it("lists a run's moves and whether each tab is still where the AI put it", async () => {
    const { runId } = await appliedRun();
    await pair(ALICE);
    const mine = await makeWorkspace(ALICE, "Mine");
    const tab0 = (await listTabs(ALICE)).find((t) => t.url === TRIP[0])!;
    await patchTab(ALICE, tab0.id, { workspaceId: mine.id });

    const detail = await runDetail(ALICE, runId);
    expect(detail.status).toBe(200);
    expect(detail.json.run.id).toBe(runId);
    expect(detail.json.moves).toHaveLength(5);
    expect(detail.json.moves.find((m: { tabRefId: string }) => m.tabRefId === tab0.id).stillAiPlaced).toBe(false);
    expect(detail.json.moves.filter((m: { stillAiPlaced: boolean }) => m.stillAiPlaced)).toHaveLength(4);
  });

  it("another user's run is a 404 for detail and undo, and nothing of theirs changes", async () => {
    const { runId } = await appliedRun();
    await pair(BOB);
    expect((await runDetail(BOB, runId)).status).toBe(404);
    expect((await undo(BOB, runId)).status).toBe(404);
    expect((await runDetail(ALICE, crypto.randomUUID())).status).toBe(404);
    expect((await listTabs(ALICE)).filter((t) => t.placementSource === "ai")).toHaveLength(5);
  });

  it("requires a token (401)", async () => {
    expect((await runDetail(null as unknown as string, crypto.randomUUID())).status).toBe(401);
    expect((await undo(null as unknown as string, crypto.randomUUID())).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe("user story 5: Home and the sidebar can read the results", () => {
  const overview = (token: string | null, qs = "") => read(overviewGet(req("GET", `/api/overview${qs}`, token)));
  const resolve = (token: string, qs: string) => read(resolveGet(req("GET", `/api/resolve?${qs}`, token)));

  /** Two AI workspaces, one pending suggestion, and one tab left in Other. */
  async function organized() {
    await seedTabs(ALICE, tabs([...TRIP, ...CODE, "https://maybe.example/a", "https://maybe.example/b", ONE_OFF]));
    installFakeModel((input) => [
      group("Kyoto trip", idsFor(input, "trip.example"), 0.95, { emoji: "🗾" }),
      group("Coding project", idsFor(input, "code.example"), 0.9, { emoji: "💻" }),
      group("Maybe a thing", idsFor(input, "maybe.example"), 0.55),
    ]);
    return (await run(ALICE)).json;
  }

  it("returns workspaces with their tabs, Other, and pending suggestions in one call", async () => {
    await organized();
    const reply = await overview(ALICE);
    expect(reply.status).toBe(200);
    expect(Object.keys(reply.json).sort()).toEqual(["other", "suggestions", "workspaces"]);

    const byName = Object.fromEntries(reply.json.workspaces.map((w: { workspace: { name: string } }) => [w.workspace.name, w]));
    expect(Object.keys(byName).sort()).toEqual(["Coding project", "Kyoto trip"]);
    expect(byName["Kyoto trip"].tabRefs.map((t: { url: string }) => t.url).sort()).toEqual([...TRIP].sort());
    expect(byName["Kyoto trip"].tabRefs.every((t: { placementSource: string }) => t.placementSource === "ai")).toBe(true);
    expect(byName["Kyoto trip"].workspace).toMatchObject({ emoji: "🗾", status: "active" });

    // Other holds everything without a workspace: the one-off and the tabs in the pending suggestion
    expect(reply.json.other.map((t: { url: string }) => t.url).sort()).toEqual([ONE_OFF, "https://maybe.example/a", "https://maybe.example/b"].sort());
    expect(reply.json.other.every((t: { workspaceId: string | null; placementSource: string | null }) => t.workspaceId === null && t.placementSource === null)).toBe(true);

    expect(reply.json.suggestions).toHaveLength(1);
    expect(reply.json.suggestions[0]).toMatchObject({ name: "Maybe a thing", status: "pending" });
    expect(reply.json.suggestions[0].tabRefs).toHaveLength(2);
  });

  it("is an empty directory, not an error, for a user with nothing yet", async () => {
    await pair(ALICE);
    const reply = await overview(ALICE);
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ workspaces: [], other: [], suggestions: [] });
  });

  it("leaves archived workspaces out unless asked, and does not list their tabs under Other", async () => {
    const { applied } = await organized();
    const kyoto = applied.find((a: { workspace: { name: string } }) => a.workspace.name === "Kyoto trip").workspace;
    await read(workspacePatch(req("PATCH", "/x", ALICE, { status: "archived" }), ctx(kyoto.id)));

    const normal = await overview(ALICE);
    expect(normal.json.workspaces.map((w: { workspace: { name: string } }) => w.workspace.name)).toEqual(["Coding project"]);
    expect(normal.json.other.some((t: { url: string }) => TRIP.includes(t.url))).toBe(false);

    const all = await overview(ALICE, "?includeArchived=true");
    expect(all.json.workspaces.map((w: { workspace: { name: string } }) => w.workspace.name).sort()).toEqual(["Coding project", "Kyoto trip"]);
  });

  it("agrees with GET /api/workspaces on the workspace ids (Home and the sidebar see the same identities)", async () => {
    await organized();
    const fromOverview = (await overview(ALICE)).json.workspaces.map((w: { workspace: { id: string } }) => w.workspace.id).sort();
    const fromList = (await read(workspacesGet(req("GET", "/api/workspaces", ALICE)))).json.workspaces.map((w: { id: string }) => w.id).sort();
    expect(fromOverview).toEqual(fromList);
  });

  it("the sidebar's resolve call says a tab was AI-placed, and that it became the user's after a move", async () => {
    await organized();
    const tabId = (await listTabs(ALICE)).find((t) => t.url === TRIP[0])!;
    const before = await resolve(ALICE, `chromeTabId=${tabId.chromeTabId}`);
    expect(before.json.workspace.name).toBe("Kyoto trip");
    expect(before.json.tabRef.placementSource).toBe("ai");

    await pair(ALICE);
    const mine = await makeWorkspace(ALICE, "Mine");
    await read(tabRefsPut(req("PUT", "/api/tab-refs", ALICE, { url: TRIP[0], workspaceId: mine.id })));
    const after = await resolve(ALICE, `url=${encodeURIComponent(TRIP[0])}`);
    expect(after.json.workspace.id).toBe(mine.id);
    expect(after.json.tabRef.placementSource).toBe("user");
  });

  it("resolve for an unplaced tab in Other says so, with no workspace", async () => {
    await organized();
    const other = (await listTabs(ALICE)).find((t) => t.url === ONE_OFF)!;
    const reply = await resolve(ALICE, `chromeTabId=${other.chromeTabId}`);
    expect(reply.json.workspace).toBeNull();
    expect(reply.json.tabRef).toMatchObject({ workspaceId: null, placementSource: null });
  });

  it("never shows one user's workspaces, tabs, or suggestions to another", async () => {
    await organized();
    await pair(BOB);
    expect((await overview(BOB)).json).toEqual({ workspaces: [], other: [], suggestions: [] });
    expect((await resolve(BOB, `url=${encodeURIComponent(TRIP[0])}`)).json).toEqual({ workspace: null, tabRef: null });
  });

  it("requires a token (401)", async () => {
    expect((await overview(null)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe("logs never carry tab content (FR-018)", () => {
  const SECRETS = ["ZQX-secret-title", "zqx-secret-host.example", "ZQX-secret-snippet", "ZQX-secret-group", "ZQX-secret-error"];

  function spyOnConsole() {
    const calls: unknown[][] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void calls.push(args)),
    );
    return {
      text: () => JSON.stringify(calls, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v)),
      restore: () => spies.forEach((spy) => spy.mockRestore()),
    };
  }

  async function seedSecrets(token: string) {
    await seedTabs(token, [
      { url: "https://zqx-secret-host.example/a?token=ZQX-secret-title", title: "ZQX-secret-title one", snippet: "ZQX-secret-snippet one" },
      { url: "https://zqx-secret-host.example/b", title: "ZQX-secret-title two", snippet: "ZQX-secret-snippet two" },
    ]);
  }

  it("a successful run and a suggestion write nothing about titles, addresses, snippets, or group names", async () => {
    await seedSecrets(ALICE);
    installFakeModel((input) => [group("ZQX-secret-group", input.tabs.map((t) => t.id), 0.9)]);
    const logs = spyOnConsole();
    try {
      expect((await run(ALICE)).status).toBe(200);
      installFakeModel((input) => [group("ZQX-secret-group", input.tabs.map((t) => t.id), 0.5)]);
      await seedSecrets(ALICE); // nothing new: the second run below is skipped or refreshed, either way quietly
      await run(ALICE, { force: true });
    } finally {
      logs.restore();
    }
    for (const secret of SECRETS) expect(logs.text(), secret).not.toContain(secret);
  });

  it("a failed run, an unexpected bug, and a budget stop leave no tab content or raw error text in the logs", async () => {
    await seedSecrets(ALICE);
    const logs = spyOnConsole();
    try {
      installFakeModel(() => {
        throw new ModelError("The AI service did not respond in time.");
      });
      await run(ALICE);
      installFakeModel(() => {
        throw new Error("boom ZQX-secret-error ZQX-secret-title");
      });
      await run(ALICE, { force: true });
      installFakeModel(() => {
        throw new BudgetExceededError();
      });
      await run(ALICE, { force: true });
    } finally {
      logs.restore();
    }
    for (const secret of SECRETS) expect(logs.text(), secret).not.toContain(secret);
  });

  it("the stored error on a failed run is generic too", async () => {
    await seedSecrets(ALICE);
    installFakeModel(() => {
      throw new Error("boom ZQX-secret-error");
    });
    const logs = spyOnConsole();
    try {
      await run(ALICE);
    } finally {
      logs.restore();
    }
    const stored = (await runsList(ALICE)).json.runs[0];
    expect(stored.error).toBe("The clustering run failed.");
  });
});
