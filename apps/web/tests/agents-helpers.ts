// Helpers for the agents tests: a fake agent model (no network, ever) that records every call and
// stops promptly when aborted, builders for valid answers of each kind, and the seeding wrappers
// from the chat tests, and wrappers that call the routes (`getAgents`, `pressAgent`, `runAndWait`,
// `tickItem`; `getRuns` is added with its route).
import { GET as agentsGet } from "@/app/api/workspaces/[id]/agents/route";
import { PATCH as planItemPatch } from "@/app/api/workspaces/[id]/plan-items/[itemId]/route";
import { POST as agentRunPost } from "@/app/api/workspaces/[id]/agents/[agentId]/run/route";
import { idle, resetJobsForTests } from "@/src/agents/jobs";
import { setAgentModelForTests, type AgentModel, type AgentModelInput } from "@/src/agents/model";
import { resetReadSlotsForTests, setPageFetcherForTests, type PageFetcher } from "@/src/agents/pages/read-pages";
import type { PageResult } from "@/src/agents/pages/fetch-page";
import { resetForTests as resetBudget } from "@/src/llm/budget";
import { resetLimiterForTests } from "@/src/llm/limiter";
import { read, req } from "./helpers";

export { addMessageAt, addPlanItem, countMessages, gate, makeWorkspace, putTabsIn, userIdOf } from "./chat-helpers";
export { idle };

/** What the fake saw for one call. */
export interface AgentCall extends AgentModelInput {
  /** True when the call's signal aborted before it answered. */
  stopped: boolean;
}

export interface FakeAgentModel extends AgentModel {
  calls: AgentCall[];
}

/** A raw answer, or a function that returns one (or throws, or waits) for a call. */
export type AgentScript = unknown | ((input: AgentModelInput, callNumber: number) => unknown | Promise<unknown>);

/** A valid raw answer for each agent (what a well-behaved model returns). */
export function defaultAnswer(agentId: string): unknown {
  switch (agentId) {
    case "compare":
      return {
        criteria: ["price", "location"],
        options: [
          { name: "First option", tab: "t1", values: ["cheap", "central"] },
          { name: "Second option", tab: "t2", values: ["pricey", "quiet"] },
        ],
        verdict: "The first option looks better on price.",
      };
    case "next-steps":
      return { items: ["Book the flights", "Compare two hotels", "Draft a day-by-day plan", "Check the rail pass", "Set a budget"] };
    case "refs":
      return { quotes: [] };
    default:
      return { text: "A short summary of what the tabs say.", cited: ["t1"] };
  }
}

/** A fake model that follows `script` (default: a valid answer for whichever agent is asked). */
export function fakeAgentModel(script?: AgentScript): FakeAgentModel {
  const calls: AgentCall[] = [];
  return {
    calls,
    answer(input, signal) {
      const call: AgentCall = { ...input, stopped: false };
      calls.push(call);
      const number = calls.length;
      const run = async () => {
        if (script === undefined) return defaultAnswer(input.agentId);
        if (typeof script === "function") return (script as (i: AgentModelInput, n: number) => unknown)(input, number);
        return script;
      };
      const aborted = new Promise<never>((_resolve, reject) => {
        const stop = () => {
          call.stopped = true;
          reject(new DOMException("aborted", "AbortError"));
        };
        if (signal?.aborted) stop();
        else signal?.addEventListener("abort", stop, { once: true });
      });
      return Promise.race([run(), aborted]);
    },
  };
}

/** What a page read looks like when nothing could be read. */
export const UNREADABLE: PageResult = { text: null, reason: "error", truncated: false };

export interface FakePageFetcher extends PageFetcher {
  /** Every address it was asked for, in order. */
  requested: string[];
}

/**
 * A page fetcher that answers per plain address from `pages` (no network, ever) and records every
 * address it was asked for. A string is the page's text; anything not listed is unreadable.
 */
export function fakePageFetcher(pages: Record<string, string | PageResult | (() => Promise<PageResult>)> = {}): FakePageFetcher {
  const requested: string[] = [];
  const fetcher: PageFetcher = async (url) => {
    requested.push(url);
    const answer = pages[url];
    if (answer === undefined) return UNREADABLE;
    if (typeof answer === "function") return answer();
    return typeof answer === "string" ? { text: answer, reason: null, truncated: false } : answer;
  };
  return Object.assign(fetcher, { requested });
}

/** Installs a fake page fetcher for the current test. `installFakeAgentModel` already installs one that reads nothing. */
export function installFakePages(pages: Record<string, string | PageResult | (() => Promise<PageResult>)> = {}): FakePageFetcher {
  const fake = fakePageFetcher(pages);
  setPageFetcherForTests(fake);
  return fake;
}

/**
 * Installs a fake agent model for the current test and resets the budget, the limiter, and the job
 * registry. It also installs a page fetcher that can read nothing, so no test can reach the network.
 */
export function installFakeAgentModel(script?: AgentScript): FakeAgentModel {
  resetBudget();
  resetLimiterForTests();
  resetJobsForTests();
  resetReadSlotsForTests();
  setPageFetcherForTests(fakePageFetcher());
  const model = fakeAgentModel(script);
  setAgentModelForTests(model);
  return model;
}

/** Call in afterEach: puts the real model (which has no key in tests) back and waits for stray jobs. */
export async function restoreAgentModel(): Promise<void> {
  await idle();
  setAgentModelForTests(null);
  setPageFetcherForTests(null);
  resetReadSlotsForTests();
  resetBudget();
  resetLimiterForTests();
  resetJobsForTests();
}

// ---- builders for valid raw answers -----------------------------------------------------------
export const textAnswer = (text: string, cited: string[] = []) => ({ text, cited });
export const checklistAnswer = (items: string[]) => ({ items });
export const quotesAnswer = (quotes: { quote: string; tab: string }[]) => ({ quotes });
export const comparisonAnswer = (criteria: string[], options: { name: string; tab: string | null; values: string[] }[], verdict = "") => ({
  criteria,
  options,
  verdict,
});

// ---- route wrappers (call the handlers the way a client would) --------------------------------

/** GET /api/workspaces/:id/agents. */
export function getAgents(token: string | null, workspaceId: string) {
  return read(agentsGet(req("GET", `/api/workspaces/${workspaceId}/agents`, token), { params: Promise.resolve({ id: workspaceId }) }));
}

/** POST /api/workspaces/:id/agents/:agentId/run. */
export function pressAgent(token: string | null, workspaceId: string, agentId: string) {
  return read(
    agentRunPost(req("POST", `/api/workspaces/${workspaceId}/agents/${agentId}/run`, token), {
      params: Promise.resolve({ id: workspaceId, agentId }),
    }),
  );
}

/** PATCH /api/workspaces/:id/plan-items/:itemId. The body is sent as given (`{ done: true }` by default). */
export function tickItem(token: string | null, workspaceId: string, itemId: string, body: unknown = { done: true }) {
  return read(planItemPatch(req("PATCH", `/api/workspaces/${workspaceId}/plan-items/${itemId}`, token, body), { params: Promise.resolve({ id: workspaceId, itemId }) }));
}

/** Presses an agent, waits for its job to finish, and returns the press reply and the agents read after it. */
export async function runAndWait(token: string, workspaceId: string, agentId: string) {
  const pressed = await pressAgent(token, workspaceId, agentId);
  await idle();
  const agents = await getAgents(token, workspaceId);
  return { pressed, agents };
}
