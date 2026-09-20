import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelUnconfiguredError } from "@/src/llm/errors";
import { getTool, setToolExecute } from "@/src/actions/registry";
import { setActionJobLimitMsForTests } from "@/src/actions/run";
import { reset } from "./helpers";
import {
  ScriptedActionModel,
  getActions,
  idle,
  installFakeActionModel,
  makeWorkspace,
  postRun,
  postSuggest,
  putTabsIn,
  restoreActionModel,
  runAndWait,
} from "./actions-helpers";

const ALICE = "alice-actions-run-token-aaaaaa";
const BOB = "bob-actions-run-token-bbbbbbbb";

async function kyoto() {
  const ws = await makeWorkspace(ALICE, "kyoto trip");
  await putTabsIn(ALICE, ws.id, [
    { url: "https://en.wikipedia.org/wiki/Kyoto", title: "Kyoto" },
    { url: "https://en.wikipedia.org/wiki/Gion", title: "Gion" },
  ]);
  return ws;
}

describe("action runs", () => {
  beforeEach(reset);
  afterEach(restoreActionModel);

  it("runs list_workspace_tabs directly with zero step calls and keeps the result", async () => {
    const model = new ScriptedActionModel({ suggest: [] });
    installFakeActionModel(model);
    const ws = await kyoto();
    await runAndWait(() => postRun(ALICE, ws.id, "list_workspace_tabs", { args: {}, label: "List tabs" }));
    const listed = await getActions(ALICE, ws.id);
    expect(listed.status).toBe(200);
    expect(listed.json.runs).toHaveLength(1);
    expect(listed.json.runs[0]).toMatchObject({ toolId: "list_workspace_tabs", state: "succeeded" });
    expect(listed.json.runs[0].output.result.text).toContain("Kyoto");
    expect(model.calls.filter((call) => call.kind === "step")).toHaveLength(0);
  });

  it("refuses a second click of the same tool while it is pending", async () => {
    installFakeActionModel(new ScriptedActionModel());
    const ws = await kyoto();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    setToolExecute("list_workspace_tabs", async () => {
      await hold;
      return { result: { kind: "text", text: "later" } };
    });
    const first = await postRun(ALICE, ws.id, "list_workspace_tabs", { args: {}, label: "List tabs" });
    expect(first.status).toBe(202);
    expect(first.json.run.state).toBe("running");
    const second = await postRun(ALICE, ws.id, "list_workspace_tabs", { args: {}, label: "List tabs" });
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("run_in_progress");
    release();
    await idle();
  });

  it("runs a composed tool with locked prefill and at most four step calls", async () => {
    const model = new ScriptedActionModel({
      step: [
        { step: "call", tool: "list_workspace_tabs", argsJson: "{}", note: "tabs" },
        {
          step: "call",
          tool: "append_plan_items",
          argsJson: JSON.stringify({ items: ["hijack this"] }),
          note: "done",
        },
      ],
    });
    installFakeActionModel(model);
    const ws = await kyoto();
    setToolExecute("append_plan_items", async ({ args }) => ({
      result: { kind: "saved", what: "plan_items", added: (args.items as string[]).length, skippedDuplicates: 0, refused: 0 },
    }));
    const locked = ["Book a ryokan"];
    await runAndWait(() =>
      postRun(ALICE, ws.id, "append_plan_items", { args: { items: locked }, label: "Add steps" }),
    );
    const listed = await getActions(ALICE, ws.id);
    expect(listed.json.runs[0].state).toBe("succeeded");
    expect(listed.json.runs[0].output.result.added).toBe(1);
    expect(model.calls.filter((call) => call.kind === "step")).toHaveLength(0);
  });

  it("keeps locked prefill when a composed run's model tries to overwrite it", async () => {
    process.env.MCP_GITHUB_URL = "https://example.com/github";
    process.env.MCP_GITHUB_TOKEN = "ghs_test";
    process.env.GITHUB_REPO = "owner/repo";
    const seen: Record<string, unknown>[] = [];
    const model = new ScriptedActionModel({
      step: [
        {
          step: "call",
          tool: "github_create_issue",
          argsJson: JSON.stringify({ title: "hijack this", body: "From the tabs" }),
          note: "done",
        },
      ],
    });
    installFakeActionModel(model);
    setToolExecute("github_create_issue", async ({ args }) => {
      seen.push(args);
      return { result: { kind: "created", service: "github", what: "issue" }, links: [] };
    });
    const ws = await kyoto();
    await runAndWait(() => postRun(ALICE, ws.id, "github_create_issue", { args: { title: "Bug" }, label: "Issue" }));
    expect(seen[0]?.title).toBe("Bug");
    expect(seen[0]?.body).toBe("From the tabs");
    expect(model.calls.filter((call) => call.kind === "step")).toHaveLength(1);
    delete process.env.MCP_GITHUB_URL;
    delete process.env.MCP_GITHUB_TOKEN;
    delete process.env.GITHUB_REPO;
  });

  it("composes missing args, refuses another writer, and records it", async () => {
    const model = new ScriptedActionModel({
      step: [
        { step: "call", tool: "slack_post_message", argsJson: JSON.stringify({ text: "nope" }), note: "bad" },
        {
          step: "call",
          tool: "append_plan_items",
          argsJson: JSON.stringify({ items: ["Walk Gion"] }),
          note: "ok",
        },
      ],
    });
    installFakeActionModel(model);
    const ws = await kyoto();
    setToolExecute("append_plan_items", async () => ({
      result: { kind: "saved", what: "plan_items", added: 1, skippedDuplicates: 0, refused: 0 },
    }));
    await runAndWait(() => postRun(ALICE, ws.id, "append_plan_items", { args: {}, label: "Add steps" }));
    const listed = await getActions(ALICE, ws.id);
    expect(listed.json.runs[0].state).toBe("succeeded");
    expect(listed.json.runs[0].output.refused).toEqual([{ tool: "slack_post_message", why: "not_allowed" }]);
    expect(model.calls.filter((call) => call.kind === "step")).toHaveLength(2);
  });

  it("fails bad_answer when the model finishes before the button's own tool", async () => {
    installFakeActionModel(
      new ScriptedActionModel({
        step: [{ step: "finish", tool: null, argsJson: null, note: null }],
      }),
    );
    const ws = await kyoto();
    await runAndWait(() => postRun(ALICE, ws.id, "append_plan_items", { args: {}, label: "Add steps" }));
    const listed = await getActions(ALICE, ws.id);
    expect(listed.json.runs[0].state).toBe("failed");
    expect(listed.json.runs[0].error.code).toBe("bad_answer");
  });

  it("stops at the step limit and does not continue", async () => {
    installFakeActionModel(
      new ScriptedActionModel({
        step: [
          { step: "call", tool: "list_workspace_tabs", argsJson: "{}", note: "1" },
          { step: "call", tool: "list_workspace_tabs", argsJson: "{}", note: "2" },
          { step: "call", tool: "list_workspace_tabs", argsJson: "{}", note: "3" },
          { step: "call", tool: "list_workspace_tabs", argsJson: "{}", note: "4" },
        ],
      }),
    );
    const ws = await kyoto();
    await runAndWait(() => postRun(ALICE, ws.id, "append_plan_items", { args: {}, label: "Add steps" }));
    const listed = await getActions(ALICE, ws.id);
    expect(listed.json.runs[0].error.code).toBe("step_limit");
    expect(listed.json.runs[0].error.partial).toMatch(/helper/);
  });

  it("times out a slow job", async () => {
    installFakeActionModel(new ScriptedActionModel());
    const ws = await kyoto();
    setActionJobLimitMsForTests(30);
    setToolExecute("list_workspace_tabs", async ({ signal }) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 5_000);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
      return { result: { kind: "text", text: "late" } };
    });
    await runAndWait(() => postRun(ALICE, ws.id, "list_workspace_tabs", { args: {}, label: "List tabs" }));
    const listed = await getActions(ALICE, ws.id);
    expect(listed.json.runs[0].error.code).toBe("timed_out");
  });

  it("enforces a per-person cap of 5 running tools", async () => {
    installFakeActionModel(new ScriptedActionModel());
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    setToolExecute("list_workspace_tabs", async () => {
      await hold;
      return { result: { kind: "text", text: "ok" } };
    });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const ws = await makeWorkspace(ALICE, `ws ${i}`);
      await putTabsIn(ALICE, ws.id, [{ url: `https://en.wikipedia.org/wiki/${i}`, title: `T${i}` }]);
      ids.push(ws.id);
      expect((await postRun(ALICE, ws.id, "list_workspace_tabs", { args: {}, label: "List" })).status).toBe(202);
    }
    const sixth = await makeWorkspace(ALICE, "ws 5");
    await putTabsIn(ALICE, sixth.id, [{ url: "https://en.wikipedia.org/wiki/Six", title: "Six" }]);
    const reply = await postRun(ALICE, sixth.id, "list_workspace_tabs", { args: {}, label: "List" });
    expect(reply.status).toBe(429);
    expect(reply.json.code).toBe("too_many_runs");
    release();
    await idle();
  });

  it("keeps finished runs after a re-read and keeps 10 plus the newest success", async () => {
    installFakeActionModel(new ScriptedActionModel());
    const ws = await kyoto();
    for (let i = 0; i < 12; i += 1) {
      await runAndWait(() => postRun(ALICE, ws.id, "list_workspace_tabs", { args: {}, label: `List ${i}` }));
    }
    const { query } = await import("@/src/db");
    const count = await query<{ n: string }>(
      "SELECT count(*) AS n FROM action_runs WHERE workspace_id = $1::uuid AND action_id = $2",
      [ws.id, "list_workspace_tabs"],
    );
    expect(Number(count.rows[0].n)).toBeLessThanOrEqual(11);
    const listed = await getActions(ALICE, ws.id);
    expect(listed.json.runs[0].state).toBe("succeeded");
  });

  it("does not start a run without a click", async () => {
    vi.useFakeTimers();
    try {
      const model = new ScriptedActionModel({
        suggest: [
          {
            suggestions: [
              { tool: "list_workspace_tabs", label: "List tabs", reason: "See them now in this workspace.", argsJson: "{}" },
              { tool: "write_summary", label: "Summarize", reason: "You have several Kyoto tabs open.", argsJson: "{}" },
              { tool: "save_search_queries", label: "Save searches", reason: "Keep the ryokan queries.", argsJson: JSON.stringify({ queries: ["kyoto ryokan"] }) },
            ],
          },
        ],
      });
      installFakeActionModel(model);
      const ws = await kyoto();
      await postSuggest(ALICE, ws.id);
      await vi.advanceTimersByTimeAsync(60_000);
      const listed = await getActions(ALICE, ws.id);
      expect(listed.json.runs).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 404 for an unknown tool and stores nothing for missing visible args", async () => {
    installFakeActionModel(new ScriptedActionModel());
    const ws = await kyoto();
    expect((await postRun(ALICE, ws.id, "not_a_real_tool", { args: {}, label: "x" })).status).toBe(404);
    const missing = await postRun(ALICE, ws.id, "open_related_tabs", { args: {}, label: "Open" });
    expect(missing.status).toBe(400);
    expect(missing.json.code).toBe("bad_input");
    expect((await getActions(ALICE, ws.id)).json.runs).toEqual([]);
  });

  it("refuses other and a missing key for composed runs without storing a row", async () => {
    installFakeActionModel({
      suggest: async () => {
        throw new ModelUnconfiguredError("no");
      },
      step: async () => {
        throw new ModelUnconfiguredError("no");
      },
    });
    const ws = await kyoto();
    expect((await postRun(ALICE, "other", "list_workspace_tabs", { args: {}, label: "x" })).json.code).toBe("not_a_workspace");
    restoreActionModel();
    const { setActionModelForTests } = await import("@/src/actions/model");
    setActionModelForTests(null);
    const { providerConfigured } = await import("@/src/llm");
    if (!providerConfigured()) {
      const composed = await postRun(ALICE, ws.id, "append_plan_items", { args: {}, label: "Add" });
      expect(composed.status).toBe(503);
    }
    expect((await getActions(ALICE, ws.id)).json.runs).toEqual([]);
  });

  it("does not leak another person's tabs", async () => {
    installFakeActionModel(new ScriptedActionModel());
    const alice = await kyoto();
    const bobWs = await makeWorkspace(BOB, "secret");
    await putTabsIn(BOB, bobWs.id, [{ url: "https://en.wikipedia.org/wiki/Secret", title: "SECRET-TAB-TITLE" }]);
    await runAndWait(() => postRun(ALICE, alice.id, "list_workspace_tabs", { args: {}, label: "List" }));
    const listed = await getActions(ALICE, alice.id);
    expect(JSON.stringify(listed.json)).not.toContain("SECRET-TAB-TITLE");
  });
});
