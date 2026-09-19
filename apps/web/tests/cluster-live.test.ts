// Opt-in: calls the REAL active AI provider (LLM_PROVIDER, default the VT ARC API, which
// needs the VT VPN), so it costs about 2 model requests. It still runs on the in-process
// test database, never on Tiger.
//
//   CLUSTER_LIVE=1 pnpm --filter @ai-browser/web test cluster-live
//   LLM_PROVIDER=gemini CLUSTER_LIVE=1 pnpm --filter @ai-browser/web test cluster-live
//
// Checks SC-001 (at least 80% of the 30-tab reference set in the right place) and one
// sample of SC-006 (a 50-tab run finishes within 30 seconds; quickstart V9 takes ten).
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as ingestPost } from "@/app/api/ingest/tabs/route";
import { POST as runsPost } from "@/app/api/cluster/runs/route";
import { scoreClusters } from "../scripts/score-lib.mjs";
import { listTabs } from "./cluster-helpers";
import { read, req, reset } from "./helpers";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const key = fixture("mixed-tabs.labels.json") as { labels: Record<string, string | null>; ambiguous: string[] };

beforeEach(reset);

describe.skipIf(process.env.CLUSTER_LIVE !== "1")("live AI provider (opt-in)", () => {
  async function seedAndRun(token: string, file: string) {
    const ingested = await read(ingestPost(req("POST", "/api/ingest/tabs", token, fixture(file))));
    expect(ingested.status).toBe(200);
    const started = Date.now();
    const reply = await read(runsPost(req("POST", "/api/cluster/runs", token, {})));
    const seconds = (Date.now() - started) / 1000;
    expect(reply.status, JSON.stringify(reply.json)).toBe(200);
    const tabs = await listTabs(token);
    return { reply, seconds, workspaceByUrl: Object.fromEntries(tabs.map((t) => [t.url, t.workspaceId])) };
  }

  it("puts at least 80% of the 30-tab reference set where a person would (SC-001)", async () => {
    const { reply, seconds, workspaceByUrl } = await seedAndRun("live-token-30-aaaa", "mixed-tabs.batch.json");
    const score = scoreClusters(key.labels, key.ambiguous, workspaceByUrl);
    console.log(
      `[live] 30 tabs: ${score.percent.toFixed(1)}% (${score.correct}/${score.total}) in ${seconds.toFixed(1)}s; ` +
        `applied=${reply.json.run.appliedCount} suggestions=${reply.json.suggestions.length} discarded=${reply.json.run.discardedCount}`,
    );
    for (const m of score.mismatches) console.log(`[live]   mismatch: ${m.label ?? "(Other)"} ${m.url}`);
    expect(score.percent).toBeGreaterThanOrEqual(80);
    expect(seconds).toBeLessThan(30);
  }, 90_000);

  it("finishes a 50-tab run within 30 seconds (one sample of SC-006)", async () => {
    const { reply, seconds } = await seedAndRun("live-token-50-bbbb", "mixed-tabs-50.batch.json");
    console.log(`[live] 50 tabs: ${seconds.toFixed(1)}s, applied=${reply.json.run.appliedCount}`);
    expect(seconds).toBeLessThan(30);
  }, 90_000);
});
