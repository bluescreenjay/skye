import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reset } from "./helpers";
import {
  ScriptedActionModel,
  installFakeActionModel,
  makeWorkspace,
  postRun,
  putTabsIn,
  restoreActionModel,
  runAndWait,
  scriptedConnector,
} from "./actions-helpers";
import { setConnectorForTests } from "@/src/actions/integrations/connector";
import { bindingFor } from "@/src/actions/integrations/bindings";

const ALICE = "alice-actions-int-token-aaaa";

describe("integration tools", () => {
  beforeEach(() => {
    reset();
    process.env.MCP_GITHUB_URL = "https://example.com/github";
    process.env.MCP_GITHUB_TOKEN = "ghs_test";
    process.env.GITHUB_REPO = "owner/repo";
  });
  afterEach(() => {
    restoreActionModel();
    delete process.env.MCP_GITHUB_URL;
    delete process.env.MCP_GITHUB_TOKEN;
    delete process.env.GITHUB_REPO;
  });

  it("creates a GitHub issue with locked prefill and dest", async () => {
    installFakeActionModel(new ScriptedActionModel());
    const connector = scriptedConnector({
      github_create_issue: { text: "ok", links: [{ label: "issue", url: "https://github.com/owner/repo/issues/1", id: "1" }] },
    });
    setConnectorForTests(connector);
    const ws = await makeWorkspace(ALICE, "kyoto");
    await putTabsIn(ALICE, ws.id, [{ url: "https://en.wikipedia.org/wiki/Kyoto", title: "Kyoto" }]);
    await runAndWait(() =>
      postRun(ALICE, ws.id, "github_create_issue", { args: { title: "Bug", body: "From the tabs" }, label: "Issue" }),
    );
    expect(connector.calls).toHaveLength(1);
    expect(connector.calls[0].args).toMatchObject({ owner: "owner", repo: "repo", title: "Bug" });
    const mapped = bindingFor("github_create_issue")!.toArguments({ title: "t", body: "b" }, "owner/repo");
    expect(JSON.stringify(mapped)).toContain("owner");
  });

  it("refuses unconnected tools with zero calls", async () => {
    delete process.env.MCP_GITHUB_URL;
    installFakeActionModel(new ScriptedActionModel());
    const connector = scriptedConnector({});
    setConnectorForTests(connector);
    const ws = await makeWorkspace(ALICE, "kyoto");
    await putTabsIn(ALICE, ws.id, [{ url: "https://en.wikipedia.org/wiki/Kyoto", title: "Kyoto" }]);
    const reply = await postRun(ALICE, ws.id, "github_create_issue", { args: { title: "Bug", body: "x" }, label: "Issue" });
    expect(reply.status).toBe(409);
    expect(reply.json.code).toBe("not_connected");
    expect(connector.calls).toHaveLength(0);
  });
});
