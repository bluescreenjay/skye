import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCollector } from "../src/collector";
import { createSender } from "../src/sender";
import { createSnapshotter } from "../src/snapshot";
import { createStore, type Store } from "../src/store";
import { installChromeMock, type ChromeMock, type MockTab } from "./helpers/chrome-mock";

// The real sender talking over real HTTP to the real stub receiver process, so
// the two halves of the ingest contract are checked against each other. The
// only fake is Chrome itself.

const STUB = join(__dirname, "..", "scripts", "stub-receiver.mjs");
const TOKEN = "integration-token";

let mock: ChromeMock;
let store: Store;
let stub: ChildProcess | undefined;
let output = "";
let port = 0;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });

async function startStub(args: string[] = []) {
  output = "";
  stub = spawn("node", [STUB, "--port", String(port), "--token", TOKEN, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  stub.stdout!.on("data", (chunk) => (output += chunk));
  stub.stderr!.on("data", (chunk) => (output += chunk));
  for (let i = 0; i < 100 && !output.includes("Stub receiver on"); i++) await new Promise((r) => setTimeout(r, 25));
  if (!output.includes("Stub receiver on")) throw new Error(`stub did not start: ${output}`);
}

async function stopStub() {
  const child = stub;
  stub = undefined;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

beforeEach(async () => {
  mock = installChromeMock();
  store = createStore();
  port = await freePort();
});
afterEach(async () => {
  await stopStub();
});

const page = (id: number, over: Partial<MockTab> = {}): MockTab => ({
  id,
  windowId: 1,
  url: `https://example.com/${id}`,
  title: `Page ${id}`,
  active: id === 1,
  ...over,
});

function wire(token = TOKEN) {
  const snapshotter = createSnapshotter({ store });
  const sender = createSender({
    store,
    getConfig: () => ({ ok: true, config: { apiBaseUrl: `http://localhost:${port}`, deviceToken: token } }),
    takeFullSnapshot: () => snapshotter.takeFullSnapshot(),
    sampleActive: () => snapshotter.sampleActive(),
    random: () => 0.5,
  });
  const collector = createCollector({ store });
  return { snapshotter, sender, collector };
}

describe("extension and stub receiver agree on the contract", () => {
  it("delivers a full snapshot, then events, and the stub sees exactly what was sent", async () => {
    await startStub();
    mock.tabs = [page(1, { title: "First" }), page(2)];
    mock.scriptResults.set(1, "  A short   article about things  ");
    const { sender, collector } = wire();

    await store.updateState({ needsFullSnapshot: true });
    expect(await sender.drainOnce()).toMatchObject({ outcome: "sent", accepted: 2, duplicates: 0 });
    expect(output).toContain("fullSnapshot=true");
    expect(output).toContain("active=win 1 / tab 1");
    expect(output).toContain("snippet(28)"); // "A short article about things" after collapsing whitespace
    expect(await store.size()).toBe(0);

    const opened = page(3);
    mock.tabs.push(opened);
    await collector.onTabCreated(opened);
    await collector.onTabRemoved(2);
    expect(await sender.drainOnce()).toMatchObject({ outcome: "sent", accepted: 2 });
    expect(output).toContain("event opened");
    expect(output).toContain("event closed");
    expect(output).toMatch(/delay this batch: max \d+ ms/);
    expect(output).toMatch(/\d+\/\d+ within 5 s/);
    expect((await store.getState()).status).toBe("ok");
  });

  it("counts a resent event once (the stub answers duplicates)", async () => {
    await startStub();
    mock.tabs = [page(1)];
    const { collector, sender } = wire();
    await collector.onTabCreated(mock.tabs[0]);

    const { events } = await store.readBatch(10);
    expect(await sender.drainOnce()).toMatchObject({ accepted: 1 });

    // Simulate a response that was lost: the same event goes out again.
    await store.apply({ events: [events[0].event] });
    expect(await sender.drainOnce()).toMatchObject({ outcome: "sent", accepted: 0, duplicates: 1 });
    expect(await store.size()).toBe(0);
  });

  it("keeps everything while the stub is down, then delivers it once it is back", async () => {
    await startStub();
    mock.tabs = [page(1)];
    const { collector, sender } = wire();
    await collector.onTabCreated(mock.tabs[0]);
    await stopStub(); // connection refused from here on

    expect(await sender.drainOnce()).toMatchObject({ outcome: "failed" });
    expect(await store.size()).toBe(1);
    expect((await store.getState()).status).toBe("retrying");

    await startStub();
    await store.updateState({ nextAttemptAt: null }); // skip the wait
    expect(await sender.drainOnce()).toMatchObject({ outcome: "sent", accepted: 1 });
    expect(await store.size()).toBe(0);
    expect((await store.getState()).status).toBe("ok");
  });

  it("stops and drops nothing when the stub rejects the token", async () => {
    await startStub();
    mock.tabs = [page(1)];
    const { collector, sender } = wire("wrong-token");
    await collector.onTabCreated(mock.tabs[0]);

    expect(await sender.drainOnce()).toEqual({ outcome: "auth_failed" });
    expect(output).toContain("missing or wrong bearer token");
    expect(await store.size()).toBe(1);
    expect((await store.getState()).status).toBe("auth_failed");
  });

  it("treats the stub's --fail 500 as a problem to wait out, keeping the data", async () => {
    await startStub(["--fail", "500"]);
    mock.tabs = [page(1)];
    const { collector, sender } = wire();
    await collector.onTabCreated(mock.tabs[0]);

    expect(await sender.drainOnce()).toMatchObject({ outcome: "failed", status: 500 });
    expect(await store.size()).toBe(1);
    expect((await store.getState()).status).toBe("retrying");
  });

  it("treats the stub's --fail 401 as rejected credentials even with the right token", async () => {
    await startStub(["--fail", "401"]);
    mock.tabs = [page(1)];
    const { collector, sender } = wire();
    await collector.onTabCreated(mock.tabs[0]);
    expect(await sender.drainOnce()).toEqual({ outcome: "auth_failed" });
    expect(await store.size()).toBe(1);
  });
});
