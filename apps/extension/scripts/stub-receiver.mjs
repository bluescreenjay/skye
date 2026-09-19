#!/usr/bin/env node
// Stand-in for the backend that feature 003 will provide. It implements the
// ingest contract in specs/002-tab-ingestion-extension/contracts/ingest-api.md
// so the extension can be verified end to end without a database.
//
//   node scripts/stub-receiver.mjs [--port 8787] [--token dev-token] [--fail MODE]
//   pnpm --filter @ai-browser/extension stub -- --fail 500
//
// --fail MODE (a switch you can restart the stub with):
//   500    answer every request with 500 (transient failure: the extension retries)
//   401    answer every request with 401 (rejected credentials: badge "!", no data dropped)
//   slow   answer normally, but only after 10 seconds (a change made meanwhile must not be lost)
//
// Behaviour: POST /api/ingest/tabs with "Authorization: Bearer <token>" and a JSON
// body. Events are de-duplicated by id and answered with { accepted, duplicates }
// where `accepted` counts newly stored events. Each batch is logged, including how
// long after it happened each event arrived (SC-001: 95% within 5 seconds).
// Nothing is written to disk; restarting the stub forgets every event id.
import { createServer } from "node:http";

function parseArgs(argv) {
  const out = { port: 8787, token: "dev-token", fail: null };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=");
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--port") out.port = Number(value());
    else if (flag === "--token") out.token = value();
    else if (flag === "--fail") out.fail = value();
  }
  if (out.fail && !["500", "401", "slow"].includes(out.fail)) {
    console.error(`Unknown --fail mode "${out.fail}". Use 500, 401, or slow.`);
    process.exit(1);
  }
  return out;
}

const { port, token, fail } = parseArgs(process.argv.slice(2));

const seenEventIds = new Set();
const lags = []; // ms between an event's time and its receipt, across all batches
let batchCount = 0;

const percentile = (sorted, p) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

const short = (text, n = 70) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const stamp = () => new Date().toISOString().slice(11, 23);

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function handleBatch(batch, res) {
  const receivedAt = Date.now();
  const events = batch.events ?? [];
  const tabs = batch.tabs ?? [];

  let accepted = 0;
  let duplicates = 0;
  const batchLags = [];
  for (const event of events) {
    if (seenEventIds.has(event.id)) {
      duplicates++;
      continue;
    }
    seenEventIds.add(event.id);
    accepted++;
    const lag = receivedAt - Date.parse(event.time);
    if (Number.isFinite(lag)) {
      lags.push(lag);
      batchLags.push(lag);
    }
  }

  batchCount++;
  const active = batch.active ?? {};
  console.log(
    `[${stamp()}] batch #${batchCount}  tabs=${tabs.length}  events=${events.length} ` +
      `(new ${accepted}, duplicate ${duplicates})  fullSnapshot=${Boolean(batch.fullSnapshot)}  ` +
      `active=win ${active.windowId ?? "-"} / tab ${active.chromeTabId ?? "-"}`,
  );
  for (const tab of tabs) {
    const snippet = tab.snippet ? ` snippet(${tab.snippet.length})` : " snippet(empty)";
    console.log(`    tab   ${String(tab.chromeTabId).padStart(5)} win ${tab.windowId}${tab.active ? " *active*" : ""}  ${short(tab.url)}${snippet}`);
  }
  for (const event of events) {
    console.log(`    event ${event.eventType.padEnd(9)} tab ${String(event.chromeTabId).padStart(5)}  ${event.id.slice(0, 8)}  ${short(event.url)}`);
  }
  if (batchLags.length > 0) {
    const sorted = [...lags].sort((a, b) => a - b);
    const within5s = sorted.filter((l) => l <= 5000).length;
    console.log(
      `    delay this batch: max ${Math.max(...batchLags)} ms | all events so far: p95 ${percentile(sorted, 95)} ms, ` +
        `${within5s}/${sorted.length} within 5 s`,
    );
  }

  const respond = () => send(res, 200, { accepted, duplicates });
  if (fail === "slow") setTimeout(respond, 10_000);
  else respond();
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
  if (req.method !== "POST" || req.url !== "/api/ingest/tabs") return send(res, 404, { error: "not found" });

  if (fail === "401") {
    console.log(`[${stamp()}] rejected request with 401 (--fail 401)`);
    return send(res, 401, { error: "unauthorized" });
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    console.log(`[${stamp()}] rejected request: missing or wrong bearer token`);
    return send(res, 401, { error: "unauthorized" });
  }
  if (fail === "500") {
    console.log(`[${stamp()}] failed request with 500 (--fail 500)`);
    return send(res, 500, { error: "simulated failure" });
  }

  let batch;
  try {
    batch = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, { error: "invalid JSON" });
  }
  if (typeof batch !== "object" || batch === null || !Array.isArray(batch.events ?? []) || !Array.isArray(batch.tabs ?? [])) {
    return send(res, 400, { error: "expected an object with tabs[] and events[]" });
  }
  handleBatch(batch, res);
});

server.listen(port, () => {
  console.log(`Stub receiver on http://localhost:${port}/api/ingest/tabs`);
  console.log(`  token: ${token}${fail ? `   failure mode: ${fail}` : ""}`);
  console.log("  Ctrl+C to stop. Event ids are remembered only while it runs.");
});

process.on("SIGINT", () => {
  const sorted = [...lags].sort((a, b) => a - b);
  console.log(
    `\n${batchCount} batches, ${seenEventIds.size} distinct events, delay p95 ${percentile(sorted, 95)} ms.`,
  );
  process.exit(0);
});
