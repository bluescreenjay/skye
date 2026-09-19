// Helpers for the agents tests: a fake agent model (no network, ever) that records every call and
// stops promptly when aborted, builders for valid answers of each kind, and the seeding wrappers
// from the chat tests. The wrappers that call the routes (`getAgents`, `pressAgent`, `getRuns`,
// `tickItem`, `runAndWait`) are added with the routes.
import { idle, resetJobsForTests } from "@/src/agents/jobs";
import { setAgentModelForTests, type AgentModel, type AgentModelInput } from "@/src/agents/model";
import { resetForTests as resetBudget } from "@/src/llm/budget";
import { resetLimiterForTests } from "@/src/llm/limiter";

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

/** Installs a fake agent model for the current test and resets the budget, the limiter, and the job registry. */
export function installFakeAgentModel(script?: AgentScript): FakeAgentModel {
  resetBudget();
  resetLimiterForTests();
  resetJobsForTests();
  const model = fakeAgentModel(script);
  setAgentModelForTests(model);
  return model;
}

/** Call in afterEach: puts the real model (which has no key in tests) back and waits for stray jobs. */
export async function restoreAgentModel(): Promise<void> {
  await idle();
  setAgentModelForTests(null);
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
