import { describe, expect, it, vi } from "vitest";
import type { AgentEntry, AgentResult, AgentRunView, AgentSource, PlanItem } from "@ai-browser/shared";
import {
  anyRunning,
  applyTick,
  describeCoverage,
  describeRunOutcome,
  matchesAddress,
  nextPollMs,
  olderRuns,
  pressAgent,
  reasonLabel,
  readAgents,
  readRuns,
  resultText,
  tickPlanItem,
} from "../src/ui/agents";

const CONFIG = { apiBaseUrl: "http://127.0.0.1:3000", deviceToken: "test-token-not-real" };
const WS = "3458835e-32f1-4dec-a537-f9b4acbbe662";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchOf = (response: Response | (() => Response | Promise<Response>)) =>
  vi.fn(async () => (typeof response === "function" ? response() : response.clone())) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
const failing = () => vi.fn(async () => Promise.reject(new TypeError("network down"))) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

const run = (over: Partial<AgentRunView> = {}): AgentRunView => ({
  id: "r1",
  agentId: "summarize",
  state: "running",
  createdAt: "2026-09-19T12:00:00.000Z",
  input: { tabsTotal: 3, tabsIncluded: 3, pagesTried: 3, chatMessages: 0, planItems: 0 },
  output: null,
  error: null,
  ...over,
});
const entry = (over: Partial<AgentEntry> = {}): AgentEntry => ({
  id: "summarize",
  name: "summarize",
  description: "a short summary of what your sources say",
  kind: "text",
  latest: null,
  running: null,
  lastFailed: null,
  ...over,
});
const item = (id: string, done = false, sortOrder = 0): PlanItem => ({ id, userId: "u1", workspaceId: WS, text: `Item ${id}`, done, sortOrder });
const source = (over: Partial<AgentSource> = {}): AgentSource => ({ title: "T", url: "https://a.example/x", read: "page", reason: null, trimmed: false, truncated: false, ...over });

describe("readAgents", () => {
  const body = { agents: [entry(), entry({ id: "compare", name: "compare", kind: "comparison" })], planItems: [item("p1")] };

  it("parses the agents call", async () => {
    const fetchImpl = fetchOf(json(200, body));
    expect(await readAgents(CONFIG, WS, { fetchImpl })).toEqual(body);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CONFIG.apiBaseUrl}/api/workspaces/${WS}/agents`);
    expect(init.method ?? "GET").toBe("GET");
  });

  it.each([401, 404, 400, 500])("returns null for a %i", async (status) => {
    expect(await readAgents(CONFIG, WS, { fetchImpl: fetchOf(json(status, { error: "no" })) })).toBeNull();
  });

  it("returns null when the server cannot be reached, or the answer is not the expected shape", async () => {
    expect(await readAgents(CONFIG, WS, { fetchImpl: failing() })).toBeNull();
    expect(await readAgents(CONFIG, WS, { fetchImpl: fetchOf(new Response("<html>", { status: 200 })) })).toBeNull();
    expect(await readAgents(CONFIG, WS, { fetchImpl: fetchOf(json(200, { agents: "nope", planItems: [] })) })).toBeNull();
    expect(await readAgents(CONFIG, WS, { fetchImpl: fetchOf(json(200, { agents: [], planItems: null })) })).toBeNull();
  });

  it("keeps only well-formed entries", async () => {
    const result = await readAgents(CONFIG, WS, { fetchImpl: fetchOf(json(200, { agents: [entry(), { id: 5 }, null], planItems: [item("p1"), "x"] })) });
    expect(result?.agents).toHaveLength(1);
    expect(result?.planItems).toHaveLength(1);
  });
});

describe("pressAgent", () => {
  const press = (response: Response | (() => Response), options: { signal?: AbortSignal } = {}) =>
    pressAgent(CONFIG, WS, "summarize", { fetchImpl: fetchOf(response), ...options });

  it("maps 202 to started with the run", async () => {
    const fetchImpl = fetchOf(json(202, { run: run() }));
    expect(await pressAgent(CONFIG, WS, "summarize", { fetchImpl })).toEqual({ kind: "started", run: run() });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CONFIG.apiBaseUrl}/api/workspaces/${WS}/agents/summarize/run`);
    expect(init.method).toBe("POST");
  });

  it("maps 409 run_in_progress to already_running", async () => {
    expect(await press(json(409, { error: "This agent is already running for this workspace.", code: "run_in_progress" }))).toEqual({ kind: "already_running" });
  });

  it.each([
    [409, "no_tabs", "Add some web tabs to this workspace first, then run an agent."],
    [429, "too_many_runs", "Several agents are already running. Wait for one to finish."],
    [503, "model_unconfigured", "The AI assistant isn't set up on this server yet."],
    [400, "not_a_workspace", "Agents are for a workspace. Move these tabs into a workspace first."],
    [404, "unknown_agent", "There is no such agent."],
  ])("maps a refusal (%i %s) to refused with the server's sentence", async (status, code, message) => {
    expect(await press(json(status, { error: message, code }))).toEqual({ kind: "refused", status, code, message });
  });

  it("gives a fixed sentence when the server sent none", async () => {
    const unauthorized = await press(json(401, {}));
    expect(unauthorized).toMatchObject({ kind: "refused", status: 401, code: null });
    expect((unauthorized as { message: string }).message).toMatch(/token/);
    const broken = await press(new Response("boom", { status: 500 }));
    expect(broken).toMatchObject({ kind: "refused", status: 500, code: null });
    expect((broken as { message: string }).message.length).toBeGreaterThan(5);
  });

  it("does not trust a 202 without a run", async () => {
    expect(await press(json(202, { nope: true }))).toMatchObject({ kind: "refused" });
  });

  it("maps a network failure to unreachable", async () => {
    expect(await pressAgent(CONFIG, WS, "summarize", { fetchImpl: failing() })).toEqual({ kind: "unreachable" });
  });
});

describe("tickPlanItem", () => {
  it("sends { done } and returns the item", async () => {
    const updated = item("p1", true);
    const fetchImpl = fetchOf(json(200, { planItem: updated }));
    expect(await tickPlanItem(CONFIG, WS, "p1", true, { fetchImpl })).toEqual(updated);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CONFIG.apiBaseUrl}/api/workspaces/${WS}/plan-items/p1`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ done: true });
    await tickPlanItem(CONFIG, WS, "p1", false, { fetchImpl });
    expect(JSON.parse((fetchImpl.mock.calls[1] as [string, RequestInit])[1].body as string)).toEqual({ done: false });
  });

  it("returns null for a refusal, an unusable answer, and a network failure", async () => {
    expect(await tickPlanItem(CONFIG, WS, "p1", true, { fetchImpl: fetchOf(json(404, { error: "Plan item not found" })) })).toBeNull();
    expect(await tickPlanItem(CONFIG, WS, "p1", true, { fetchImpl: fetchOf(json(200, { planItem: 5 })) })).toBeNull();
    expect(await tickPlanItem(CONFIG, WS, "p1", true, { fetchImpl: failing() })).toBeNull();
  });
});

describe("readRuns", () => {
  it("parses the page and asks for the paging it was given", async () => {
    const page = { runs: [run({ id: "r2", state: "failed", error: { code: "timed_out", message: "x" } }), run({ id: "r1" })], hasMore: true };
    const fetchImpl = fetchOf(json(200, page));
    expect(await readRuns(CONFIG, WS, "summarize", { before: "r0", limit: 5 }, { fetchImpl })).toEqual(page);
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toBe(`${CONFIG.apiBaseUrl}/api/workspaces/${WS}/agents/summarize/runs?limit=5&before=r0`);
    await readRuns(CONFIG, WS, "summarize", {}, { fetchImpl });
    expect((fetchImpl.mock.calls[1] as [string])[0]).toBe(`${CONFIG.apiBaseUrl}/api/workspaces/${WS}/agents/summarize/runs`);
  });

  it("returns null when it cannot be read", async () => {
    expect(await readRuns(CONFIG, WS, "summarize", {}, { fetchImpl: fetchOf(json(400, { code: "invalid_cursor" })) })).toBeNull();
    expect(await readRuns(CONFIG, WS, "summarize", {}, { fetchImpl: fetchOf(json(200, { runs: 1 })) })).toBeNull();
    expect(await readRuns(CONFIG, WS, "summarize", {}, { fetchImpl: failing() })).toBeNull();
  });
});

describe("requests", () => {
  it("carry the bearer token in a header and never in the address", async () => {
    const fetchImpl = fetchOf(json(200, { agents: [], planItems: [], runs: [], hasMore: false, run: run(), planItem: item("p1") }));
    await readAgents(CONFIG, WS, { fetchImpl });
    await pressAgent(CONFIG, WS, "compare", { fetchImpl });
    await readRuns(CONFIG, WS, "compare", { limit: 3, before: "r1" }, { fetchImpl });
    await tickPlanItem(CONFIG, WS, "p1", true, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    for (const [url, init] of fetchImpl.mock.calls as [string, RequestInit][]) {
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${CONFIG.deviceToken}`);
      expect(url).not.toContain(CONFIG.deviceToken);
      expect(String(init.body ?? "")).not.toContain(CONFIG.deviceToken);
    }
  });

  it("encode the ids they put in the address", async () => {
    const fetchImpl = fetchOf(json(200, { agents: [], planItems: [] }));
    await readAgents(CONFIG, "a/b?c", { fetchImpl });
    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe(`${CONFIG.apiBaseUrl}/api/workspaces/a%2Fb%3Fc/agents`);
  });

  it("stop when the caller's signal aborts, without throwing", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    const pending = readAgents(CONFIG, WS, { fetchImpl, signal: controller.signal });
    controller.abort();
    expect(await pending).toBeNull();
  });
});

describe("polling", () => {
  it("anyRunning and nextPollMs follow the running entries", () => {
    const idle = [entry(), entry({ id: "compare", latest: run({ state: "succeeded" }) })];
    const busy = [entry(), entry({ id: "compare", running: run() })];
    expect(anyRunning(idle)).toBe(false);
    expect(anyRunning(busy)).toBe(true);
    expect(nextPollMs(idle)).toBeNull();
    expect(nextPollMs(busy)).toBe(3000);
    expect(nextPollMs([])).toBeNull();
  });
});

describe("describeCoverage", () => {
  it("says how many tabs were read and why the rest were not", () => {
    const sources = [
      ...Array.from({ length: 6 }, (_, i) => source({ url: `https://a.example/${i}` })),
      source({ read: "excerpt", reason: "needs_sign_in" }),
      source({ read: "excerpt", reason: "needs_sign_in" }),
      source({ read: "excerpt", reason: "too_slow" }),
    ];
    expect(describeCoverage(sources, { tabsTotal: 9, tabsIncluded: 9, pagesRead: 6 })).toBe("read 6 of 9 tabs; 3 not read: needs sign-in (2), too slow (1)");
  });

  it("uses the singular, and says nothing about unread pages when every page was read", () => {
    expect(describeCoverage([source()], { tabsTotal: 1, tabsIncluded: 1, pagesRead: 1 })).toBe("read 1 of 1 tab");
  });

  it("says when only titles and excerpts were used", () => {
    const text = describeCoverage([source({ read: "excerpt", reason: "error" }), source({ read: "excerpt", reason: "private_address" })], { tabsTotal: 2, tabsIncluded: 2, pagesRead: 0 });
    expect(text).toContain("read 0 of 2 tabs");
    expect(text).toContain("2 not read");
    expect(text).toMatch(/titles.*excerpts/);
  });

  it("mentions pages read at their plain address, and pages that were cut short", () => {
    const sources = [source({ trimmed: true }), source({ trimmed: true, url: "https://a.example/2" }), source({ url: "https://a.example/3", truncated: true })];
    const text = describeCoverage(sources, { tabsTotal: 3, tabsIncluded: 3, pagesRead: 3 });
    expect(text).toContain("2 pages were read at their plain address");
    expect(text).toContain("1 page was cut short");
    expect(describeCoverage([source({ trimmed: true })], { tabsTotal: 1, tabsIncluded: 1, pagesRead: 1 })).toContain("1 page was read at its plain address");
  });

  it("mentions tabs that were left out of the run", () => {
    expect(describeCoverage([source()], { tabsTotal: 12, tabsIncluded: 9, pagesRead: 1 })).toContain("3 more tabs were left out");
  });

  it("gives every reason a lowercase phrase", () => {
    for (const reason of ["private_address", "not_secure", "needs_sign_in", "not_a_web_page", "too_large", "too_slow", "no_text", "error", "over_limit"] as const) {
      const label = reasonLabel(reason);
      expect(label).toBe(label.toLowerCase());
      expect(label.length).toBeGreaterThan(3);
    }
    expect(reasonLabel("needs_sign_in")).toBe("needs sign-in");
  });
});

describe("applyTick", () => {
  it("returns a new list with one item changed, and reverting gives back exactly what there was", () => {
    const before = [item("a", false, 0), item("b", true, 1), item("c", false, 2)];
    const snapshot = JSON.parse(JSON.stringify(before));
    const ticked = applyTick(before, "a", true);
    expect(ticked).not.toBe(before);
    expect(ticked.map((i) => [i.id, i.done])).toEqual([["a", true], ["b", true], ["c", false]]);
    expect(before).toEqual(snapshot); // the original was not changed
    expect(applyTick(ticked, "a", false)).toEqual(before); // an exact revert
    expect(applyTick(before, "b", false).map((i) => i.done)).toEqual([false, false, false]);
  });

  it("leaves the list as it was for an id that is not there", () => {
    const before = [item("a")];
    expect(applyTick(before, "zzz", true)).toEqual(before);
  });
});

describe("resultText", () => {
  const HOSTILE = '<img src=x onerror=alert(1)> **bold** [link](javascript:alert(1)) ![p](https://evil.example/p.png)';
  const tab = { title: HOSTILE, url: "https://a.example/x" };

  it("turns each result kind into plain strings", () => {
    const cases: [AgentResult, string[]][] = [
      [{ kind: "text", text: "Two paragraphs.\n\nSecond.", cited: [tab] }, ["Two paragraphs.\n\nSecond.", `from: ${HOSTILE}`]],
      [{ kind: "text", text: "No sources.", cited: [] }, ["No sources."]],
      [{ kind: "checklist", items: ["one", "two"] }, ["one", "two"]],
      [{ kind: "quotes", quotes: [{ quote: "exact words here", tab }], note: "1 quote could not be verified and was left out." }, [`“exact words here” — ${HOSTILE}`, "1 quote could not be verified and was left out."]],
      [
        { kind: "comparison", criteria: ["price", "location"], options: [{ name: "A", tab, values: ["cheap", "central"] }, { name: "B", tab: null, values: ["pricey", "quiet"] }], verdict: "A wins." },
        ["A: price = cheap; location = central", "B: price = pricey; location = quiet", "A wins."],
      ],
    ];
    for (const [result, expected] of cases) expect(resultText(result)).toEqual(expected);
  });

  it("hands hostile text back exactly as it came, never escaped, stripped, or turned into markup", () => {
    const lines = resultText({ kind: "text", text: HOSTILE, cited: [] });
    expect(lines).toEqual([HOSTILE]);
    expect(resultText({ kind: "checklist", items: [HOSTILE] })).toEqual([HOSTILE]);
    expect(resultText({ kind: "quotes", quotes: [{ quote: HOSTILE, tab }], note: null })[0]).toContain(HOSTILE);
  });

  it("omits an empty verdict and an empty note", () => {
    expect(resultText({ kind: "comparison", criteria: ["a", "b"], options: [{ name: "A", tab: null, values: ["1", "2"] }], verdict: "" })).toEqual(["A: a = 1; b = 2"]);
    expect(resultText({ kind: "quotes", quotes: [], note: null })).toEqual([]);
  });
});

describe("matchesAddress", () => {
  it("matches a tab's address to the plain address a result shows", () => {
    expect(matchesAddress("https://a.example/x?token=1#top", "https://a.example/x")).toBe(true);
    expect(matchesAddress("https://a.example/x", "https://a.example/x")).toBe(true);
    expect(matchesAddress("https://a.example/y", "https://a.example/x")).toBe(false);
    expect(matchesAddress("https://a.example/xy", "https://a.example/x")).toBe(false);
  });

  it("matches an address that was cut for display", () => {
    const long = `https://a.example/${"p".repeat(300)}`;
    expect(matchesAddress(`${long}?q=1`, long.slice(0, 200))).toBe(true);
    expect(matchesAddress(`https://a.example/${"q".repeat(300)}`, long.slice(0, 200))).toBe(false);
  });
});

describe("earlier runs", () => {
  const ok = (id: string, over: Partial<AgentRunView> = {}) =>
    run({ id, state: "succeeded", output: { result: { kind: "text", text: `Result ${id}`, cited: [] }, sources: [], coverage: { tabsTotal: 1, tabsIncluded: 1, pagesRead: 0 } }, ...over });

  it("says how a run ended in one plain line", () => {
    expect(describeRunOutcome(ok("a"))).toBe("succeeded");
    expect(describeRunOutcome(run({ state: "running" }))).toBe("running");
    expect(describeRunOutcome(run({ state: "failed", error: { code: "timed_out", message: "This run did not finish. You can run it again." } }))).toBe("This run did not finish. You can run it again.");
    expect(describeRunOutcome(run({ state: "failed", error: null }))).toBe("failed");
  });

  it("leaves out the runs the card already shows, and keeps the order it was given", () => {
    const runs = [run({ id: "r5", state: "running" }), ok("r4"), ok("r3"), run({ id: "r2", state: "failed", error: { code: "model_error", message: "x" } }), ok("r1")];
    const shown = entry({ latest: ok("r4"), running: run({ id: "r5", state: "running" }) });
    expect(olderRuns(shown, runs).map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
    expect(olderRuns(entry(), runs).map((r) => r.id)).toEqual(["r5", "r4", "r3", "r2", "r1"]);
  });

  it("presents an older checklist as read-only text: exactly the items it proposed, as plain lines", () => {
    const older = ok("old", { agentId: "next-steps", output: { result: { kind: "checklist", items: ["Book <b>flights</b>", "Pack"] }, sources: [], coverage: { tabsTotal: 1, tabsIncluded: 1, pagesRead: 0 } } });
    expect(resultText(older.output!.result)).toEqual(["Book <b>flights</b>", "Pack"]);
  });
});
