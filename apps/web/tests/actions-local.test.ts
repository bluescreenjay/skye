import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeAgentModel, restoreAgentModel } from "./agents-helpers";
import { reset } from "./helpers";
import {
  ScriptedActionModel,
  getActions,
  getExport,
  idle,
  installFakeActionModel,
  makeWorkspace,
  postIntent,
  postRun,
  putTabsIn,
  restoreActionModel,
  runAndWait,
} from "./actions-helpers";
import { setPageFetcherForTests } from "@/src/agents/pages/read-pages";

const ALICE = "alice-actions-local-token-aaaa";

async function seeded() {
  const ws = await makeWorkspace(ALICE, "kyoto trip");
  await putTabsIn(ALICE, ws.id, [
    { url: "https://en.wikipedia.org/wiki/Kyoto", title: "Kyoto", snippet: "Kyoto is a city in Japan with many temples." },
    { url: "https://en.wikipedia.org/wiki/Gion", title: "Gion", snippet: "Gion is a district in Kyoto." },
  ]);
  return ws;
}

describe("local summary tools", () => {
  beforeEach(reset);
  afterEach(async () => {
    restoreActionModel();
    await restoreAgentModel();
  });

  it("writes, exports, copies, and shares a summary", async () => {
    installFakeActionModel(new ScriptedActionModel());
    installFakeAgentModel({ text: "Kyoto has temples and Gion is nearby.", cited: ["t1"] });
    const ws = await seeded();
    await runAndWait(() => postRun(ALICE, ws.id, "write_summary", { args: {}, label: "Summarize" }));
    const listed = await getActions(ALICE, ws.id);
    expect(listed.json.summary.text).toContain("Kyoto");
    const md = await getExport(ALICE, ws.id, "md");
    expect(md.status).toBe(200);
    expect(md.body.toString("utf8")).toContain("Kyoto has temples");
    const pdf = await getExport(ALICE, ws.id, "pdf");
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.body.toString("latin1").startsWith("%PDF-")).toBe(true);
    await runAndWait(() => postRun(ALICE, ws.id, "copy_text", { args: {}, label: "Copy" }));
    expect((await getActions(ALICE, ws.id)).json.runs.find((r: { toolId: string }) => r.toolId === "copy_text").output.result.text).toContain("Kyoto");
    await runAndWait(() => postRun(ALICE, ws.id, "compose_share_link", { args: {}, label: "Share" }));
    const share = (await getActions(ALICE, ws.id)).json.runs.find((r: { toolId: string }) => r.toolId === "compose_share_link");
    expect(share.output.result.text).toContain("kyoto trip");
    expect(share.output.result.text.length).toBeLessThan(2_000);
  });

  it("refuses export without a summary", async () => {
    installFakeActionModel(new ScriptedActionModel());
    const ws = await seeded();
    const md = await getExport(ALICE, ws.id, "md");
    expect(md.status).toBe(409);
    expect(md.json.code).toBe("no_summary");
    expect((await getExport(ALICE, ws.id, "docx")).status).toBe(400);
  });
});

describe("browser intents", () => {
  beforeEach(reset);
  afterEach(restoreActionModel);

  it("opens https tabs, skips insecure addresses, and reports", async () => {
    installFakeActionModel(new ScriptedActionModel());
    const ws = await seeded();
    const started = await postRun(ALICE, ws.id, "open_related_tabs", {
      args: { urls: ["https://en.wikipedia.org/wiki/Fushimi_Inari-taisha", "http://example.com"], placeInWorkspace: true },
      label: "Open pages",
    });
    await idle();
    const running = (await getActions(ALICE, ws.id)).json.runs[0];
    expect(running.state).toBe("running");
    expect(running.awaitingIntents[0].urls).toEqual(["https://en.wikipedia.org/wiki/Fushimi_Inari-taisha"]);
    const intentId = running.awaitingIntents[0].id;
    const reported = await postIntent(ALICE, ws.id, running.id, intentId, { status: "done", opened: 1, failed: 0, placed: 1 });
    expect(reported.status).toBe(200);
    expect(reported.json.run.state).toBe("succeeded");
    expect(reported.json.run.output.result.opened).toBe(1);
    expect((await postIntent(ALICE, ws.id, running.id, intentId, { status: "done", opened: 1, failed: 0, placed: 1 })).status).toBe(409);
    void started;
  });

  it("opens google searches from server-built addresses", async () => {
    installFakeActionModel(new ScriptedActionModel());
    const ws = await seeded();
    await postRun(ALICE, ws.id, "open_google_searches", { args: { queries: ["kyoto ryokan"] }, label: "Search" });
    await idle();
    const running = (await getActions(ALICE, ws.id)).json.runs[0];
    expect(running.awaitingIntents[0].urls[0]).toMatch(/^https:\/\/www\.google\.com\/search\?q=/);
  });
});

describe("save tools", () => {
  beforeEach(reset);
  afterEach(restoreActionModel);

  it("appends plan items, saves queries and refs, and reads pages in-workspace", async () => {
    installFakeActionModel(new ScriptedActionModel());
    const ws = await seeded();
    await runAndWait(() => postRun(ALICE, ws.id, "append_plan_items", { args: { items: ["Book a ryokan", "book a ryokan"] }, label: "Plan" }));
    await runAndWait(() => postRun(ALICE, ws.id, "save_search_queries", { args: { queries: ["kyoto ryokan with onsen"] }, label: "Save" }));
    setPageFetcherForTests(async () => ({ text: "Kyoto is a city in Japan with many temples.", reason: null, truncated: false }));
    await runAndWait(() =>
      postRun(ALICE, ws.id, "save_refs", { args: { refs: [{ quote: "Kyoto is a city in Japan", tab: "t1" }] }, label: "Refs" }),
    );
    await runAndWait(() => postRun(ALICE, ws.id, "read_public_pages", { args: { tabs: ["t1"] }, label: "Read" }));
    const listed = await getActions(ALICE, ws.id);
    expect(listed.json.queries).toEqual(["kyoto ryokan with onsen"]);
    expect(listed.json.refsCount).toBe(1);
    const other = await makeWorkspace(ALICE, "other trip");
    await putTabsIn(ALICE, other.id, [{ url: "https://en.wikipedia.org/wiki/Osaka", title: "Osaka-SECRET" }]);
    await runAndWait(() => postRun(ALICE, ws.id, "list_workspace_tabs", { args: {}, label: "List" }));
    const tabs = (await getActions(ALICE, ws.id)).json.runs.find((r: { toolId: string }) => r.toolId === "list_workspace_tabs");
    expect(tabs.output.result.text).not.toContain("Osaka-SECRET");
    expect((await postRun(ALICE, "other", "list_workspace_tabs", { args: {}, label: "x" })).json.code).toBe("not_a_workspace");
  });
});
