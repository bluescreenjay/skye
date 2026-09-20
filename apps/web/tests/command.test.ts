import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "@/src/db";
import { BudgetExceededError, ModelError, ModelUnconfiguredError } from "@/src/llm/errors";
import * as m from "@/src/command/messages";
import { usage } from "@/src/llm/budget";
import { reset } from "./helpers";
import {
  ans,
  apply,
  ctxHome,
  dbSnapshot,
  installFakeCommandModel,
  makeWorkspace,
  person,
  restoreCommandModel,
  say,
  seedTabs,
  undoState,
} from "./command-helpers";
import { POST as applyPost } from "@/app/api/command/apply/route";
import { POST as commandPost } from "@/app/api/command/route";
import { GET as undoGet } from "@/app/api/command/undo/route";
import { read, req } from "./helpers";

const ALICE = "alice-device-token-0001";
const BOB = "bob-device-token-000002";

// A switch that makes the last step of every change (writing the undo record) fail, as a database error would.
// A real SQL error inside a transaction breaks the in-process PGlite connection the whole test run shares, so the
// failure is injected as an exception at the same point; the rollback it exercises is the same.
const failing = vi.hoisted(() => ({ undoWrite: false }));
vi.mock("@/src/command/undo", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/src/command/undo")>();
  return {
    ...original,
    recordUndo: (...args: Parameters<typeof original.recordUndo>) => {
      if (failing.undoWrite) throw new Error("disk full");
      return original.recordUndo(...args);
    },
  };
});

beforeEach(async () => {
  await reset();
  await person(ALICE);
  await person(BOB);
});
afterEach(() => {
  restoreCommandModel();
  vi.restoreAllMocks();
});

describe("who may call", () => {
  it("is 401 without a token on all three routes, and no AI request is made", async () => {
    const fake = installFakeCommandModel();
    expect((await say(null, "organize my tabs")).status).toBe(401);
    expect((await apply(null, { type: "undo" })).status).toBe(401);
    expect((await undoState(null)).status).toBe(401);
    expect((await read(commandPost(req("POST", "/api/command", "not-a-known-token-1", { text: "x", context: ctxHome() })))).status).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("what is refused before any AI request (SC-008)", () => {
  it("empty and whitespace text is 400 text_empty and makes no request", async () => {
    const fake = installFakeCommandModel();
    for (const text of ["", "   ", "\n\t "]) {
      const reply = await say(ALICE, text);
      expect(reply.status).toBe(400);
      expect(reply.json).toEqual({ error: m.TEXT_EMPTY, code: "text_empty" });
    }
    expect((await read(commandPost(req("POST", "/api/command", ALICE, { context: ctxHome() })))).json.code).toBe("text_empty");
    expect(fake.calls).toHaveLength(0);
    expect(usage().byPurpose.command).toBe(0);
  });

  it("301 characters is 400 text_too_long, 300 is accepted, and nothing is trimmed silently", async () => {
    const fake = installFakeCommandModel(ans("unsupported"));
    const tooLong = await say(ALICE, "a".repeat(301));
    expect(tooLong.status).toBe(400);
    expect(tooLong.json.code).toBe("text_too_long");
    expect(fake.calls).toHaveLength(0);
    expect((await say(ALICE, "a".repeat(300))).status).toBe(200);
    expect(fake.calls).toHaveLength(1);
  });

  it("a bad time zone or a malformed context is 400 and makes no request", async () => {
    const fake = installFakeCommandModel();
    expect((await say(ALICE, "hello", ctxHome({ timeZone: "Mars/Olympus" }))).json.code).toBe("bad_time_zone");
    const broken = { surface: "kitchen", timeZone: "America/New_York", expandedWorkspaceIds: [], activeTab: null, windowTabIds: [] };
    expect((await say(ALICE, "hello", broken as never)).json.code).toBe("bad_context");
    expect((await say(ALICE, "hello", ctxHome({ expandedWorkspaceIds: ["not-a-uuid"] }))).json.code).toBe("bad_context");
    expect((await say(ALICE, "hello", ctxHome({ windowTabIds: [1.5] }))).json.code).toBe("bad_context");
    expect((await read(commandPost(req("POST", "/api/command", ALICE)))).json.code).toBe("bad_context");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("a submitted command", () => {
  it("makes exactly one AI request and changes nothing", async () => {
    await seedTabs(ALICE, [{ url: "https://example.com/a", title: "A" }, { url: "https://example.com/b", title: "B" }]);
    await makeWorkspace(ALICE, "Kyoto trip");
    const fake = installFakeCommandModel(ans("unsupported"));
    const before = await dbSnapshot();
    const reply = await say(ALICE, "write me a poem about Kyoto");
    expect(reply.status).toBe(200);
    expect(fake.calls).toHaveLength(1);
    expect(usage().byPurpose.command).toBe(0); // the fake replaces the provider, where the budget is spent
    expect(await dbSnapshot()).toBe(before);
  });

  it("answers an unsupported command with a plain refusal and the six examples, and nothing else", async () => {
    installFakeCommandModel(ans("unsupported"));
    const reply = await say(ALICE, "write me a poem");
    expect(reply.json).toEqual({ kind: "say", message: m.CANT_DO, help: [...m.HELP] });
    expect(reply.json.help).toHaveLength(6);
  });

  it("sends the model only the person's own workspaces and tabs", async () => {
    await makeWorkspace(ALICE, "Kyoto trip");
    await makeWorkspace(BOB, "Bobs secret plan");
    await seedTabs(BOB, [{ url: "https://bob.example/private", title: "Bobs private page" }]);
    await seedTabs(ALICE, [{ url: "https://example.com/mine", title: "My page" }]);
    const fake = installFakeCommandModel();
    await say(ALICE, "hello");
    expect(fake.calls[0].prompt).toContain("Kyoto trip");
    expect(fake.calls[0].prompt).toContain("My page");
    expect(fake.calls[0].prompt).not.toContain("Bobs secret plan");
    expect(fake.calls[0].prompt).not.toContain("Bobs private page");
  });
});

describe("when the AI service cannot help", () => {
  it.each([
    ["the daily allowance", new BudgetExceededError(), 429, "budget_exhausted", m.AI_DAILY],
    ["the vendor's quota", new BudgetExceededError("The AI service's quota has been reached. Try again later."), 429, "budget_exhausted", m.AI_QUOTA],
    ["a busy service", new BudgetExceededError("The AI service is busy right now. Try again in a moment."), 503, "busy", m.AI_BUSY],
    ["the VPN being off", new ModelError("The AI service is only reachable on the VT VPN. Connect to it."), 502, "model_error", m.AI_VPN],
    ["any other failure", new ModelError("vendor said something with tab title SECRET"), 502, "model_error", m.AI_FAILED],
    ["a missing key thrown by the model", new ModelUnconfiguredError(), 503, "model_unconfigured", m.AI_UNCONFIGURED],
  ])("maps %s to a fixed sentence and leaves the database unchanged", async (_name, error, status, code, message) => {
    await seedTabs(ALICE, [{ url: "https://example.com/a", title: "A" }]);
    installFakeCommandModel(() => {
      throw error;
    });
    const before = await dbSnapshot();
    const reply = await say(ALICE, "organize my tabs");
    expect(reply.status).toBe(status);
    expect(reply.json).toEqual({ error: message, code });
    expect(JSON.stringify(reply.json)).not.toContain("SECRET");
    expect(await dbSnapshot()).toBe(before);
  });

  it("with no key and no override is 503 model_unconfigured before anything is read", async () => {
    restoreCommandModel(); // the real model: no key in tests
    const spy = vi.spyOn(Pool.prototype, "query");
    await say(ALICE, ""); // refused by the guard: only the sign-in lookup touches the database
    const baseline = spy.mock.calls.length;
    expect(baseline).toBeGreaterThan(0); // the spy does see the sign-in lookup, so equality below is meaningful
    spy.mockClear();
    const reply = await say(ALICE, "organize my tabs");
    expect(reply.status).toBe(503);
    expect(reply.json).toEqual({ error: m.AI_UNCONFIGURED, code: "model_unconfigured" });
    expect(spy.mock.calls.length).toBe(baseline);
  });

  it("an answer in the wrong shape is a plain failure, not an action", async () => {
    installFakeCommandModel("just words");
    const reply = await say(ALICE, "organize my tabs");
    expect(reply.status).toBe(502);
    expect(reply.json.code).toBe("model_error");
  });
});

describe("GET /api/command/undo", () => {
  it("is null for a fresh person and makes no AI request", async () => {
    const fake = installFakeCommandModel();
    const reply = await undoState(ALICE);
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ undo: null });
    expect(fake.calls).toHaveLength(0);
    expect((await read(undoGet(req("GET", "/api/command/undo", ALICE)))).json).toEqual({ undo: null });
  });
});

describe("POST /api/command/apply", () => {
  it("refuses a malformed action with 400 bad_action", async () => {
    for (const action of [undefined, null, "undo", {}, { type: "explode" }, { type: "move", tabRefIds: [], toWorkspaceId: null }, { type: "rename", workspaceId: "nope", name: "x" }, { type: "create", name: "", tabRefIds: [] }]) {
      const reply = await apply(ALICE, action as never);
      expect(reply.status, JSON.stringify(action)).toBe(400);
      expect(reply.json.code).toBe("bad_action");
    }
    expect((await read(applyPost(new Request("http://localhost/api/command/apply", { method: "POST", headers: { authorization: `Bearer ${ALICE}` }, body: "not json" })))).json.code).toBe("bad_action");
  });

  it("does not run an agent: the client presses those through the 010 route", async () => {
    const reply = await apply(ALICE, { type: "agent", workspaceId: crypto.randomUUID(), agentId: "summarize" } as never);
    expect(reply.status).toBe(400);
    expect(reply.json.code).toBe("bad_action");
  });

  it("says there is nothing to undo for a person with no change, and changes nothing", async () => {
    const before = await dbSnapshot();
    const reply = await apply(ALICE, { type: "undo" });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ status: "nothing_to_do", message: m.NOTHING_TO_UNDO, undo: null });
    expect(await dbSnapshot()).toBe(before);
  });

  it("makes no AI request", async () => {
    const fake = installFakeCommandModel();
    await apply(ALICE, { type: "undo" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("two people", () => {
  it("never see each other's undo row", async () => {
    await query(`INSERT INTO command_undo (user_id, kind, summary, payload) SELECT id, 'move', 'moved 1 tab to X', '{"v":1,"moves":[]}'::jsonb FROM users LIMIT 1`);
    const rows = (await query<{ user_id: string }>("SELECT user_id FROM command_undo")).rows;
    expect(rows).toHaveLength(1);
    const alice = await undoState(ALICE);
    const bob = await undoState(BOB);
    expect([alice.json.undo, bob.json.undo].filter((u) => u !== null)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------
// User Story 6: failures leave nothing half-done, and changes never interleave.
// ---------------------------------------------------------------------------------------------------
import { setAbortAfterMsForTests } from "@/src/command/limits";
import { gate, listTabs } from "./command-helpers";

describe("failures leave nothing half-done", () => {
  afterEach(() => setAbortAfterMsForTests(null));

  it("a model that never answers is stopped at the deadline: a plain failure, the database untouched", async () => {
    await seedTabs(ALICE, [{ url: "https://example.com/a", title: "A" }]);
    const hold = gate();
    installFakeCommandModel(async () => {
      await hold.wait; // never released
      return ans("organize");
    });
    setAbortAfterMsForTests(60);
    const before = await dbSnapshot();
    const started = Date.now();
    const reply = await say(ALICE, "organize my tabs");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(reply.status).toBe(502);
    expect(reply.json).toEqual({ error: m.AI_FAILED, code: "model_error" });
    expect(await dbSnapshot()).toBe(before);
    hold.release();
  });

  it("a change whose undo record cannot be written rolls the WHOLE change back: no workspace, no moved tab, no event", async () => {
    const tabs = await seedTabs(ALICE, [{ url: "https://example.com/a", title: "A" }, { url: "https://example.com/b", title: "B" }]);
    const before = await dbSnapshot();
    failing.undoWrite = true;
    try {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const reply = await apply(ALICE, { type: "create", name: "Never made", tabRefIds: tabs.map((t) => t.id) });
      expect(reply.status).toBe(500);
      expect(reply.json).toEqual({ error: m.COMMAND_FAILED });
      expect(error).toHaveBeenCalledWith("[command] apply failed", "Error"); // the class name only, never the message
    } finally {
      failing.undoWrite = false;
    }
    expect(await dbSnapshot()).toBe(before); // rolled back: nothing half-done
    expect((await listTabs(ALICE)).every((t) => t.workspaceId === null && t.placementSource === null)).toBe(true);
    expect((await query("SELECT 1 FROM workspaces WHERE name = 'Never made'")).rows).toHaveLength(0);
    expect((await query("SELECT 1 FROM tab_events WHERE event_type = 'reassigned'")).rows).toHaveLength(0);
    // And the very next command works: the failure left the connection and the lock clean.
    expect((await apply(ALICE, { type: "create", name: "Made after", tabRefIds: tabs.map((t) => t.id) })).json.status).toBe("done");
  });

  it("two changing commands at once never interleave: the second sees the first's result", async () => {
    const tabs = await seedTabs(ALICE, [{ url: "https://example.com/a", title: "A" }, { url: "https://example.com/b", title: "B" }, { url: "https://example.com/c", title: "C" }]);
    const [one, two] = await Promise.all([
      apply(ALICE, { type: "create", name: "Same name", tabRefIds: [tabs[0].id] }),
      apply(ALICE, { type: "create", name: "same NAME", tabRefIds: [tabs[1].id] }),
    ]);
    const statuses = [one.json.status, two.json.status].sort();
    expect(statuses).toEqual(["done", "refused"]);
    expect([one.json, two.json].find((r) => r.status === "refused").code).toBe("name_taken");
    expect((await query("SELECT 1 FROM workspaces WHERE lower(name) = 'same name'")).rows).toHaveLength(1);
    const row = (await query<{ summary: string }>("SELECT summary FROM command_undo")).rows;
    expect(row).toHaveLength(1);
    expect(row[0].summary).toMatch(/^created same name with 1 tab$/i); // it belongs to the change that happened
  });
});
