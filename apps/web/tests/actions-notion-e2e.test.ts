// A button click on a Notion action, end to end: the route, the run job, the real MCP client, and a real stdio
// child process shaped like @notionhq/notion-mcp-server (tests/fixtures/fake-notion-mcp.mjs). No network.
// This is the path the fake-connector tests cannot cover: what a real server's answer turns into on the run.
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectionStatus } from "@/src/actions/integrations/config";
import { reset } from "./helpers";
import { ScriptedActionModel, getActions, idle, installFakeActionModel, makeWorkspace, postRun, putTabsIn, restoreActionModel, runAndWait } from "./actions-helpers";

const ALICE = "alice-notion-e2e-token-aaaa";
const KEYS = ["MCP_NOTION_COMMAND", "MCP_NOTION_ARGS", "MCP_NOTION_TOKEN", "NOTION_PARENT_PAGE_ID", "MCP_NOTION_URL"];
const saved: Record<string, string | undefined> = {};
const server = fileURLToPath(new URL("./fixtures/fake-notion-mcp.mjs", import.meta.url));

type Run = { toolId: string; state: string; output: { links: { url: string | null; id: string | null; label: string }[]; result: { kind: string } } | null; error: { code: string; message: string } | null };

beforeEach(() => {
  reset();
  for (const key of KEYS) saved[key] = process.env[key];
  process.env.MCP_NOTION_URL = "";
  process.env.MCP_NOTION_COMMAND = process.execPath;
  process.env.MCP_NOTION_ARGS = JSON.stringify([server]);
  process.env.MCP_NOTION_TOKEN = "ntn_SENTINEL_E2E_0123456789";
  process.env.NOTION_PARENT_PAGE_ID = "28a56d0e-01dc-41dc-9f87-39fbc01a2f11";
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

async function latest(wsId: string, toolId: string): Promise<Run> {
  const listed = await getActions(ALICE, wsId);
  return (listed.json.runs as Run[]).find((row) => row.toolId === toolId)!;
}

describe("Notion through the real MCP client", () => {
  it("a click creates a page and the run shows its link and id (FR-016)", async () => {
    const ws = await workspace();
    await runAndWait(async () => {
      const started = await postRun(ALICE, ws.id, "notion_create_page", { args: { title: "Kyoto summary", content: "one\ntwo" }, label: "Save to Notion" });
      expect(started.status).toBe(202);
    });
    const run = await latest(ws.id, "notion_create_page");
    expect(run.state).toBe("succeeded");
    expect(run.output?.result.kind).toBe("created");
    expect(run.output?.links).toEqual([
      { label: "Kyoto summary", url: "https://www.notion.so/Kyoto-summary-11111111222233334444555555555555", id: "11111111-2222-3333-4444-555555555555" },
    ]);
  }, 60_000);

  it("the page it created can be appended to, and no other page can", async () => {
    const ws = await workspace();
    await runAndWait(() => postRun(ALICE, ws.id, "notion_create_page", { args: { title: "Kyoto summary" }, label: "Save" }));
    const created = await latest(ws.id, "notion_create_page");
    const pageId = created.output!.links[0].id!;

    await runAndWait(async () => {
      const ok = await postRun(ALICE, ws.id, "notion_append_blocks", { args: { page: pageId, content: "more notes" }, label: "Add" });
      expect(ok.status).toBe(202);
    });
    expect((await latest(ws.id, "notion_append_blocks")).state).toBe("succeeded");

    // A page this workspace did not create is refused AT THE CLICK (400 bad_input): nothing is stored and nothing is sent to Notion.
    const refused = await postRun(ALICE, ws.id, "notion_append_blocks", { args: { page: "99999999-0000-0000-0000-000000000000", content: "x" }, label: "Add" });
    expect(refused.status).toBe(400);
    expect(refused.json.code).toBe("bad_input");
    await idle();
    const runs = (await getActions(ALICE, ws.id)).json.runs as Run[];
    expect(runs.filter((run) => run.toolId === "notion_append_blocks")).toHaveLength(1); // only the earlier good append
  }, 60_000);

  it("a search shows titled results as a search result", async () => {
    const ws = await workspace();
    await runAndWait(() => postRun(ALICE, ws.id, "notion_search", { args: { text: "kyoto" }, label: "Search Notion" }));
    const run = await latest(ws.id, "notion_search");
    expect(run.state).toBe("succeeded");
    expect(run.output?.result.kind).toBe("search");
    expect((run.output!.result as unknown as { items: { title: string }[] }).items.map((i) => i.title)).toEqual(["Kyoto ryokan shortlist", "Packing list"]);
  }, 60_000);

  it("Notion refusing a request fails the run plainly, and Notion stays connected for the next click", async () => {
    const ws = await workspace();
    await runAndWait(() => postRun(ALICE, ws.id, "notion_create_page", { args: { title: "NOTSHARED" }, label: "Save" }));
    const failed = await latest(ws.id, "notion_create_page");
    expect(failed.state).toBe("failed");
    expect(failed.error?.code).toBe("service_error");
    expect(JSON.stringify(failed)).not.toMatch(/SENTINEL|object_not_found|shared with your integration/); // no token, no service text
    expect(connectionStatus("notion")).toBe("connected");

    await runAndWait(() => postRun(ALICE, ws.id, "notion_create_page", { args: { title: "Fine" }, label: "Save" }));
    expect((await latest(ws.id, "notion_create_page")).state).toBe("succeeded");
  }, 60_000);

  it("a rejected token fails the run with a plain 'connect' message and Notion drops out", async () => {
    const ws = await workspace();
    await runAndWait(() => postRun(ALICE, ws.id, "notion_create_page", { args: { title: "AUTH" }, label: "Save" }));
    const failed = await latest(ws.id, "notion_create_page");
    expect(failed.state).toBe("failed");
    expect(failed.error?.code).toBe("rejected_credentials");
    expect(connectionStatus("notion")).toBe("rejected");
    const again = await postRun(ALICE, ws.id, "notion_create_page", { args: { title: "Fine" }, label: "Save" });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("not_connected");
  }, 60_000);
});
