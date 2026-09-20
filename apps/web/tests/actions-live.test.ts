// Opt-in: real AI provider and/or real MCP servers. Still uses the in-process PGlite
// database and never touches Tiger. Never calls a write tool or reads mail.
//
//   ACTIONS_LIVE=1 pnpm --filter @ai-browser/web test actions-live --disable-console-intercept
//   ACTIONS_LIVE_GITHUB=1 pnpm --filter @ai-browser/web test actions-live --disable-console-intercept
//
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { IntegrationId } from "@ai-browser/shared";
import { getTool } from "@/src/actions/registry";
import { probeIntegration } from "@/src/actions/integrations/mcp-client";
import { connectionStatus, integrationConfig } from "@/src/actions/integrations/config";
import { mcpConnector } from "@/src/actions/integrations/mcp-client";
import { bindingFor } from "@/src/actions/integrations/bindings";
import { activeProvider } from "@/src/llm";
import { reset } from "./helpers";
import { getActions, makeWorkspace, postRun, postSuggest, putTabsIn, restoreActionModel, runAndWait } from "./actions-helpers";

const batch = JSON.parse(readFileSync(new URL("./fixtures/mixed-tabs.batch.json", import.meta.url), "utf8")) as {
  tabs: { url: string; title: string; snippet: string }[];
};
const TRIP = /kyoto|japan|yen|jpy|tea ceremony/i;
const tripTabs = batch.tabs.filter((t) => TRIP.test(`${t.title} ${t.url}`)).map(({ url, title, snippet }) => ({ url, title, snippet }));

const ALICE = "actions-live-alice-0001";
const CATALOG = 30;
const pace = () => (activeProvider() === "gemini" ? new Promise((resolve) => setTimeout(resolve, 4_500)) : Promise.resolve());

beforeEach(reset);

describe.skipIf(process.env.ACTIONS_LIVE !== "1")("ACTIONS_LIVE provider (opt-in)", () => {
  it("suggests 3 to 6 buttons within 10s and never the catalog (SC-001)", async () => {
    restoreActionModel();
    expect(tripTabs.length).toBeGreaterThanOrEqual(3);
    const ws = await makeWorkspace(ALICE, "Kyoto trip");
    await putTabsIn(ALICE, ws.id, tripTabs);
    const started = Date.now();
    const reply = await postSuggest(ALICE, ws.id);
    const totalMs = Date.now() - started;
    console.log(`[live] suggest ${totalMs}ms status=${reply.json.status} n=${reply.json.suggestions?.length ?? 0} provider=${activeProvider()}`);
    expect(reply.status).toBe(200);
    expect(reply.json.status).toBe("ok");
    expect(reply.json.suggestions.length).toBeGreaterThanOrEqual(3);
    expect(reply.json.suggestions.length).toBeLessThanOrEqual(6);
    expect(reply.json.suggestions.length).toBeLessThan(CATALOG);
    const ids = reply.json.suggestions.map((s: { toolId: string }) => s.toolId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(totalMs).toBeLessThanOrEqual(10_000);
    const listed = await getActions(ALICE, ws.id);
    expect(listed.json.runs).toEqual([]);
    await pace();
  }, 60_000);

  it("finishes one composed local run within 30s (SC-004)", async () => {
    restoreActionModel();
    const ws = await makeWorkspace(ALICE, "Kyoto trip");
    await putTabsIn(ALICE, ws.id, tripTabs);
    const started = Date.now();
    await runAndWait(() => postRun(ALICE, ws.id, "append_plan_items", { args: {}, label: "Add steps" }));
    const totalMs = Date.now() - started;
    const listed = await getActions(ALICE, ws.id);
    const run = listed.json.runs.find((row: { toolId: string }) => row.toolId === "append_plan_items");
    console.log(`[live] composed append_plan_items ${totalMs}ms state=${run?.state} provider=${activeProvider()}`);
    expect(run?.state).toBe("succeeded");
    expect(getTool("append_plan_items")?.integration).toBeNull();
    expect(totalMs).toBeLessThanOrEqual(30_000);
  }, 90_000);
});

const PROBES: { flag: string; integrations: IntegrationId[] }[] = [
  { flag: "GITHUB", integrations: ["github"] },
  { flag: "JIRA", integrations: ["jira"] },
  { flag: "NOTION", integrations: ["notion"] },
  { flag: "SLACK", integrations: ["slack"] },
  { flag: "GOOGLE", integrations: ["drive", "gmail", "calendar"] },
];

for (const probe of PROBES) {
  describe.skipIf(process.env[`ACTIONS_LIVE_${probe.flag}`] !== "1")(`ACTIONS_LIVE_${probe.flag} tools/list (opt-in)`, () => {
    it("connects and lists bindings without calling a write or reading mail", async () => {
      restoreActionModel();
      for (const integration of probe.integrations) {
        const status = connectionStatus(integration);
        if (status !== "connected") {
          const cfg = integrationConfig(integration);
          const lacking = [!cfg.transport && "transport (MCP_*_URL or MCP_*_COMMAND)", !cfg.credentialPresent && "credential", !cfg.destination && "destination"].filter(Boolean);
          console.log(`[live] ${integration} status=${status}; not probing. Missing: ${lacking.join(", ") || "(none; it was rejected earlier)"}`);
          continue;
        }
        const result = await probeIntegration(integration);
        const bound = result.resolved.filter((row) => row.bound);
        const unbound = result.resolved.filter((row) => !row.bound);
        console.log(
          `[live] ${integration} listed=${result.listed.length} resolved=${bound.map((row) => `${row.toolId}->${row.bound}`).join(",") || "(none)"} missing=${unbound.map((row) => row.toolId).join(",") || "(none)"}`,
        );
        if (bound.length === 0 && result.listed.length === 0) {
          throw new Error(
            `${integration} connected but tools/list returned nothing. Stop: a static MCP credential may not work; flag the REST-connector pivot instead of rewriting the product.`,
          );
        }
        if (unbound.length > 0) {
          console.log(`[live] ${integration} listed names: ${result.listed.slice(0, 40).join(", ")}`);
        }
        expect(result.listed).not.toContain("gmail_search_messages");

        // One real READ through the app's own connector: proves the token is accepted and that the answer parses.
        // Only tools that change nothing are ever called here.
        const search = ["notion_search", "github_search", "jira_search"].find((id) => bindingFor(id)?.integration === integration && result.resolved.some((row) => row.toolId === id && row.bound));
        if (search) {
          const binding = bindingFor(search)!;
          const answer = await mcpConnector().call(search, binding.toArguments({ text: integration === "notion" ? "" : "test", query: "test", kind: "issues" }, integrationConfig(integration).destination ?? ""), AbortSignal.timeout(20_000));
          console.log(`[live] ${integration} read ${search}: items=${answer.items?.length ?? 0} links=${answer.links.length} first="${(answer.items?.[0]?.title ?? "").slice(0, 30)}"`);
          expect(connectionStatus(integration)).toBe("connected");
        }
      }
    }, 60_000);
  });
}
