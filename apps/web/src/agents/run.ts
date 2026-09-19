// The life of one agent run (specs/010-workspace-agents/research.md sections 1 and 6). Order matters:
//   1. make sure a model is configured, BEFORE anything is stored;
//   2. gather ONE workspace's material; refuse when there are no web tabs (no AI request, nothing stored);
//   3. store a `pending` run (a unique index refuses a second run of the same agent) and return at once;
//   4. in a background job: read pages (US3), ask the model ONCE, validate the answer, and finish the run.
// Any failure after step 3 marks the run failed with a fixed sentence and changes nothing else. A
// result is stored as finished only after the whole answer exists and validated. Nothing here logs.
import type { AgentRunInput, AgentRunView, AgentSource } from "@ai-browser/shared";
import { query } from "../db";
import type { DbWorkspace } from "../map";
import type { AgentDef } from "./catalog";
import { gatherMaterial, type Gathered } from "./context";
import { failureFor, noTabs } from "./errors";
import { JOB_LIMIT_MS } from "./limits";
import { startJob } from "./jobs";
import { getAgentModel, type AgentModel } from "./model";
import { buildPrompt, type RunMaterial } from "./prompt";
import { failRun, finishRunSucceeded, insertPendingRun } from "./runs";
import { validateAnswer, type MaterialTab } from "./validate";

let jobLimitOverride: number | null = null;
/** Tests only: shorten the job limit (null restores it). */
export function setJobLimitMsForTests(ms: number | null): void {
  jobLimitOverride = ms;
}
const jobLimitMs = () => jobLimitOverride ?? JOB_LIMIT_MS;

/** Press an agent: refuse what must be refused, store a pending run, start the job, and return the pending run. */
export async function startAgentRun(userId: string, workspace: Pick<DbWorkspace, "id" | "name">, agent: AgentDef): Promise<AgentRunView> {
  const model = getAgentModel(); // throws when no key is set, before anything is stored

  const gathered = await gatherMaterial(userId, workspace);
  if (gathered.tabs.length === 0) throw noTabs();

  const input: AgentRunInput = {
    tabsTotal: gathered.tabsTotal,
    tabsIncluded: gathered.tabs.length,
    pagesTried: 0,
    chatMessages: gathered.chat.length,
    planItems: gathered.plan.length,
  };
  const run = await insertPendingRun(userId, workspace.id, agent.id, input);
  startJob(() => executeRun(run.id, userId, agent, gathered, model));
  return run;
}

/** The job. It marks its own run failed on any error, so it never throws. */
async function executeRun(runId: string, userId: string, agent: AgentDef, gathered: Gathered, model: AgentModel): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), jobLimitMs());
  try {
    const promptTabs: RunMaterial["tabs"] = gathered.tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, read: "excerpt", text: t.excerpt }));
    const material: RunMaterial = {
      workspaceName: gathered.workspaceName,
      tabsTotal: gathered.tabsTotal,
      pagesRead: 0,
      tabs: promptTabs,
      plan: gathered.plan,
      chat: gathered.chat,
    };
    const answer = await model.answer({ agentId: agent.id, prompt: buildPrompt(agent, material), schema: agent.schema }, controller.signal);

    const checkable: MaterialTab[] = promptTabs.map((t) => ({ id: t.id, title: t.title, url: t.url, material: t.text }));
    const result = validateAnswer(agent, answer, checkable);
    const sources: AgentSource[] = gathered.tabs.map((t) => ({ title: t.title, url: t.url, read: "excerpt", reason: null, trimmed: t.trimmed, truncated: false }));
    const output = { result, sources, coverage: { tabsTotal: gathered.tabsTotal, tabsIncluded: gathered.tabs.length, pagesRead: 0 } };
    await finishRunSucceeded({ query }, runId, userId, output);
  } catch (error) {
    await failRun(runId, userId, failureFor(error, { timedOut: controller.signal.aborted }));
  } finally {
    clearTimeout(timer);
  }
}
