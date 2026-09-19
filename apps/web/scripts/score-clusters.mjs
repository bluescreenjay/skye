#!/usr/bin/env node
// Prints the SC-001 score for a user's tabs after a clustering run.
//
//   node apps/web/scripts/score-clusters.mjs <deviceToken>
//   API_BASE=http://localhost:3000 node apps/web/scripts/score-clusters.mjs <deviceToken>
//
// It reads GET /api/tab-refs with that token and scores the tabs whose URL is in
// tests/fixtures/mixed-tabs.labels.json. Never prints the token.
import { readFileSync } from "node:fs";
import { scoreClusters } from "./score-lib.mjs";

const token = process.argv[2];
if (!token) {
  console.error("usage: node apps/web/scripts/score-clusters.mjs <deviceToken>");
  process.exit(2);
}
const base = (process.env.API_BASE ?? "http://localhost:3000").replace(/\/$/, "");
const key = JSON.parse(readFileSync(new URL("../tests/fixtures/mixed-tabs.labels.json", import.meta.url), "utf8"));

const response = await fetch(`${base}/api/tab-refs`, { headers: { authorization: `Bearer ${token}` } });
if (!response.ok) {
  console.error(`GET /api/tab-refs failed: ${response.status}`);
  process.exit(1);
}
const { tabRefs } = await response.json();
const workspaceByUrl = Object.fromEntries(tabRefs.map((t) => [t.url, t.workspaceId]));

const result = scoreClusters(key.labels, key.ambiguous, workspaceByUrl);
console.log(`SC-001: ${result.percent.toFixed(1)}% (${result.correct} of ${result.total} tabs where a person would put them)`);
console.log(result.percent >= 80 ? "PASS (at least 80%)" : "FAIL (under 80%)");
if (result.mismatches.length > 0) {
  console.log("\nMismatches:");
  for (const m of result.mismatches) {
    console.log(`  ${m.label ?? "(Other)"}  ${m.url}\n      expected ${m.expectedWorkspace ?? "Other"}, got ${m.actualWorkspace ?? "Other"}`);
  }
}
process.exitCode = result.percent >= 80 ? 0 : 1;
