import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelUnconfiguredError } from "@/src/llm/errors";
import { reset } from "./helpers";
import {
  ScriptedActionModel,
  gate,
  getActions,
  installFakeActionModel,
  makeWorkspace,
  postSuggest,
  putTabsIn,
  restoreActionModel,
} from "./actions-helpers";

const ALICE = "alice-actions-suggest-token-aaaa";

function localSuggestions(tools: string[]) {
  return {
    suggestions: tools.map((tool) => ({
      tool,
      label: `Do ${tool.replaceAll("_", " ")}`,
      reason: "This workspace has several Kyoto tabs worth using.",
      argsJson: argsFor(tool),
    })),
  };
}

function argsFor(tool: string): string {
  switch (tool) {
    case "save_search_queries":
      return JSON.stringify({ queries: ["kyoto ryokan with onsen", "gion walking route"] });
    case "append_plan_items":
      return JSON.stringify({ items: ["Book a ryokan", "Walk Gion at dusk"] });
    case "open_google_searches":
      return JSON.stringify({ queries: ["kyoto ryokan", "fushimi inari"] });
    case "list_workspace_tabs":
    case "write_summary":
    default:
      return "{}";
  }
}

describe("action suggestions", () => {
  beforeEach(reset);
  afterEach(restoreActionModel);

  async function kyoto() {
    const ws = await makeWorkspace(ALICE, "kyoto trip");
    await putTabsIn(ALICE, ws.id, [
      { url: "https://en.wikipedia.org/wiki/Kyoto", title: "Kyoto" },
      { url: "https://en.wikipedia.org/wiki/Gion,_Kyoto", title: "Gion" },
      { url: "https://en.wikipedia.org/wiki/Fushimi_Inari-taisha", title: "Fushimi Inari" },
    ]);
    return ws;
  }

  it("makes one suggest call, keeps 3 to 6 local tools, and runs nothing", async () => {
    const model = new ScriptedActionModel({
      suggest: [localSuggestions(["list_workspace_tabs", "write_summary", "save_search_queries", "open_google_searches"])],
    });
    installFakeActionModel(model);
    const ws = await kyoto();
    const reply = await postSuggest(ALICE, ws.id);
    expect(reply.status).toBe(200);
    expect(reply.json.status).toBe("ok");
    expect(reply.json.suggestions).toHaveLength(4);
    expect(reply.json.reused).toBe(false);
    expect(model.calls.map((c) => c.kind)).toEqual(["suggest"]);
    expect(model.calls[0].prompt).toContain("list_workspace_tabs");
    expect(model.calls[0].prompt).not.toContain("MK-MAIL");
    const listed = await getActions(ALICE, ws.id);
    expect(listed.json.runs).toEqual([]);
    expect(listed.json.summary).toBeNull();
  });

  it("drops unconnected, owner-only, unknown, duplicate, and invalid suggestions and does not pad", async () => {
    const model = new ScriptedActionModel({
      suggest: [
        {
          suggestions: [
            { tool: "slack_post_message", label: "Post to Slack", reason: "Share it", argsJson: "{\"text\":\"hi\"}" },
            { tool: "gmail_create_draft", label: "Draft", reason: "Mail", argsJson: "{\"subject\":\"s\",\"body\":\"b\"}" },
            { tool: "nope", label: "Nope", reason: "Nope", argsJson: "{}" },
            { tool: "list_workspace_tabs", label: "List tabs", reason: "See them", argsJson: "{}" },
            { tool: "list_workspace_tabs", label: "List again", reason: "Again", argsJson: "{}" },
            { tool: "write_summary", label: "", reason: "empty label", argsJson: "{}" },
            { tool: "save_search_queries", label: "Save searches", reason: "Keep them", argsJson: "not-json" },
          ],
        },
      ],
    });
    installFakeActionModel(model);
    const ws = await kyoto();
    const reply = await postSuggest(ALICE, ws.id);
    expect(reply.status).toBe(200);
    expect(reply.json.status).toBe("ok");
    expect(reply.json.suggestions.map((s: { toolId: string }) => s.toolId)).toEqual(["list_workspace_tabs"]);
    expect(reply.json.note).toMatch(/Only 1/);
  });

  it("returns a failed pass with HTTP 200 when the model errors or returns nothing usable", async () => {
    installFakeActionModel(new ScriptedActionModel({ suggest: [{ suggestions: [] }] }));
    const ws = await kyoto();
    const empty = await postSuggest(ALICE, ws.id);
    expect(empty.status).toBe(200);
    expect(empty.json).toMatchObject({ status: "failed", suggestions: [], note: "Couldn't pick actions right now. Try refresh." });

    restoreActionModel();
    installFakeActionModel(new ScriptedActionModel({ suggest: [new Error("boom")] }));
    const failed = await postSuggest(ALICE, ws.id, { force: true });
    expect(failed.status).toBe(200);
    expect(failed.json.status).toBe("failed");
  });

  it("joins in-flight passes and reuses an unchanged set", async () => {
    const hold = gate();
    const model = new ScriptedActionModel({
      suggest: [localSuggestions(["list_workspace_tabs", "write_summary", "append_plan_items"])],
      hold: hold.wait,
    });
    installFakeActionModel(model);
    const ws = await kyoto();
    const first = postSuggest(ALICE, ws.id);
    const second = postSuggest(ALICE, ws.id);
    hold.release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(model.calls).toHaveLength(1);

    const reused = await postSuggest(ALICE, ws.id);
    expect(reused.json.reused).toBe(true);
    expect(model.calls).toHaveLength(1);

    const refresh = await postSuggest(ALICE, ws.id, { force: true });
    expect(refresh.json.reused).toBe(true);
  });

  it("refuses other, unknown tokens, and a missing key", async () => {
    const model = new ScriptedActionModel({
      suggest: [localSuggestions(["list_workspace_tabs", "write_summary", "save_search_queries"])],
    });
    installFakeActionModel(model);
    await makeWorkspace(ALICE, "temp");
    expect((await postSuggest(ALICE, "other")).json).toMatchObject({ code: "not_a_workspace" });
    expect((await postSuggest(ALICE, "other")).status).toBe(400);
    expect((await postSuggest(null, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).status).toBe(401);
    restoreActionModel();
    installFakeActionModel({
      suggest: async () => {
        throw new ModelUnconfiguredError("No AI model key is configured: set VT_LLM_API_KEY.");
      },
      step: async () => ({}),
    });
    // getActionModel throws before suggest when no override... override is set.
    // Simulate unconfigured by restoring the real model with blank keys (global-setup already blanks them).
    restoreActionModel();
    const ws = await kyoto();
    const reply = await postSuggest(ALICE, ws.id);
    expect(reply.status).toBe(503);
    expect(reply.json.code).toBe("model_unconfigured");
    expect(reply.json.error).toContain("isn't set up");
  });
});
