#!/usr/bin/env node
// Shows whether each integration connects, and what is missing when it does not. READ-ONLY: it lists tools and makes
// one search per service; it never creates, changes, posts, or sends anything, and never reads mail.
//
//   pnpm --filter @ai-browser/web probe:integrations            (all)
//   pnpm --filter @ai-browser/web probe:integrations notion     (github | jira | notion | slack | google)
//
// It reads the repo-root .env with a small parser (never `source`: a value with a `?` or `&` breaks zsh and the error
// prints the line). Secrets are passed to the child process only through its environment and are never printed.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const env = { ...process.env };
const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) value = value.slice(1, -1);
    if (env[key] === undefined) env[key] = value; // a variable that is already set is never overridden
  }
}

const NAMES = ["github", "jira", "notion", "slack", "google"];
const wanted = process.argv.slice(2).map((name) => name.toLowerCase());
const unknown = wanted.filter((name) => !NAMES.includes(name));
if (unknown.length > 0) {
  console.error(`unknown: ${unknown.join(", ")}. Choose from: ${NAMES.join(", ")}`);
  process.exit(2);
}
for (const name of wanted.length > 0 ? wanted : NAMES) env[`ACTIONS_LIVE_${name.toUpperCase()}`] = "1";

const result = spawnSync("pnpm", ["exec", "vitest", "run", "tests/actions-live.test.ts", "--disable-console-intercept", "-t", "tools/list"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env,
  encoding: "utf8",
});
// Show only the lines this tool writes, redacting anything that looks like a token.
const redact = (text) => text.replace(/\b(ntn_|secret_|ghp_|github_pat_|xox[abp]-|ya29\.)[A-Za-z0-9_.-]+/g, "$1<redacted>");
const lines = `${result.stdout}\n${result.stderr}`.split("\n").filter((line) => line.includes("[live]") || /Tests |Test Files|FAIL|Error/.test(line));
console.log(redact(lines.join("\n")));
process.exit(result.status ?? 1);
