// A target the person or a suggestion names (an issue, a page, a file) is checked at the click, before a run is
// stored: a destination this workspace may not use is a plain 400 bad_input, not a failed run. (FR-033, contracts/http.md)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reset } from "./helpers";
import { ScriptedActionModel, getActions, installFakeActionModel, makeWorkspace, postRun, putTabsIn, restoreActionModel, scriptedConnector } from "./actions-helpers";
import { setConnectorForTests } from "@/src/actions/integrations/connector";

const ALICE = "alice-actions-targets-aaaa";
const KEYS = ["MCP_JIRA_URL", "MCP_JIRA_TOKEN", "JIRA_PROJECT_KEY", "MCP_GITHUB_URL", "MCP_GITHUB_TOKEN", "GITHUB_REPO"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  reset();
  for (const key of KEYS) saved[key] = process.env[key];
  process.env.MCP_JIRA_URL = "https://example.com/jira";
  process.env.MCP_JIRA_TOKEN = "jira-token";
  process.env.JIRA_PROJECT_KEY = "KYO";
  process.env.MCP_GITHUB_URL = "https://example.com/github";
  process.env.MCP_GITHUB_TOKEN = "gh-token";
  process.env.GITHUB_REPO = "owner/repo";
  installFakeActionModel(new ScriptedActionModel({}));
});
afterEach(() => {
  restoreActionModel();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function workspace() {
  const ws = await makeWorkspace(ALICE, "Kyoto trip");
  await putTabsIn(ALICE, ws.id, [{ url: "https://example.com/a", title: "A", snippet: "s" }]);
  return ws;
}

describe("targets are checked at the click", () => {
  it("a Jira issue outside the configured project is 400 bad_input, nothing stored, nothing sent", async () => {
    const connector = scriptedConnector({ jira_add_comment: { text: "ok" } });
    setConnectorForTests(connector);
    const ws = await workspace();
    const refused = await postRun(ALICE, ws.id, "jira_add_comment", { args: { key: "OTHER-7", body: "hi" }, label: "Comment" });
    expect(refused.status).toBe(400);
    expect(refused.json.code).toBe("bad_input");
    expect(connector.calls).toHaveLength(0);
    expect((await getActions(ALICE, ws.id)).json.runs).toEqual([]);
  });

  it("a Jira issue in the configured project is accepted", async () => {
    setConnectorForTests(scriptedConnector({ jira_add_comment: { text: "ok" } }));
    const ws = await workspace();
    const started = await postRun(ALICE, ws.id, "jira_add_comment", { args: { key: "KYO-7", body: "hi" }, label: "Comment" });
    expect(started.status).toBe(202);
  });

  it("a Jira key that only starts with the project letters is refused (KYOTO-1 is not KYO-1)", async () => {
    setConnectorForTests(scriptedConnector({ jira_add_comment: { text: "ok" } }));
    const ws = await workspace();
    const refused = await postRun(ALICE, ws.id, "jira_add_comment", { args: { key: "KYOTO-1", body: "hi" }, label: "Comment" });
    expect(refused.status).toBe(400);
  });

  it("a GitHub issue that is not a positive whole number is refused", async () => {
    setConnectorForTests(scriptedConnector({ github_comment_on_issue: { text: "ok" } }));
    const ws = await workspace();
    for (const issue of [0, -3, 1.5, "7"]) {
      const refused = await postRun(ALICE, ws.id, "github_comment_on_issue", { args: { issue, body: "hi" }, label: "Comment" });
      expect(refused.status, `issue=${JSON.stringify(issue)}`).toBe(400);
    }
  });
});
