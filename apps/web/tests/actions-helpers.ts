// Helpers for the action-tool tests: a scripted ActionModel (no network), a scripted connector,
// and the seeding wrappers from the chat/agents tests.
import { GET as actionsGet } from "@/app/api/workspaces/[id]/actions/route";
import { POST as suggestPost } from "@/app/api/workspaces/[id]/actions/suggest/route";
import { POST as runPost } from "@/app/api/workspaces/[id]/actions/[toolId]/run/route";
import { GET as exportGet } from "@/app/api/workspaces/[id]/summary/export/route";
import { POST as intentPost } from "@/app/api/workspaces/[id]/actions/runs/[runId]/intents/[intentId]/route";
import { POST as confirmPost } from "@/app/api/workspaces/[id]/actions/runs/[runId]/confirm/route";
import { POST as cancelPost } from "@/app/api/workspaces/[id]/actions/runs/[runId]/cancel/route";
import { idle, resetJobsForTests } from "@/src/agents/jobs";
import { resetReadSlotsForTests, setPageFetcherForTests } from "@/src/agents/pages/read-pages";
import { resetForTests as resetBudget } from "@/src/llm/budget";
import { resetLimiterForTests } from "@/src/llm/limiter";
import {
  setActionModelForTests,
  type ActionModel,
  type ActionModelInput,
} from "@/src/actions/model";
import { setConnectorForTests } from "@/src/actions/integrations/connector";
import { resetIntegrationHealthForTests } from "@/src/actions/integrations/config";
import { resetSuggestCacheForTests } from "@/src/actions/suggest/cache";
import { executeListTabs } from "@/src/actions/tools/local/list-tabs";
import { executeAppendPlan } from "@/src/actions/tools/local/append-plan";
import { integrationExecute } from "@/src/actions/tools/integration";
import { setToolExecute } from "@/src/actions/registry";
import { setActionJobLimitMsForTests } from "@/src/actions/run";
import type { IntegrationId } from "@ai-browser/shared";
import { read, req } from "./helpers";

export { addMessageAt, addPlanItem, makeWorkspace, putTabsIn, userIdOf } from "./agents-helpers";
export { idle };
export { gate } from "./chat-helpers";

export interface ModelCall {
  kind: "suggest" | "step";
  prompt: string;
  schema: unknown;
}

export class ScriptedActionModel implements ActionModel {
  readonly calls: ModelCall[] = [];
  private suggestScript: unknown[];
  private stepScript: unknown[];
  private hold: Promise<void> | null;

  constructor(script: { suggest?: unknown[]; step?: unknown[]; hold?: Promise<void> } = {}) {
    this.suggestScript = [...(script.suggest ?? [])];
    this.stepScript = [...(script.step ?? [])];
    this.hold = script.hold ?? null;
  }

  async suggest(input: ActionModelInput, signal?: AbortSignal): Promise<unknown> {
    this.calls.push({ kind: "suggest", prompt: input.prompt, schema: input.schema });
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (this.hold) await this.hold;
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const next = this.suggestScript.shift();
    if (next === undefined) throw new Error("no scripted suggest answer");
    if (next instanceof Error) throw next;
    return next;
  }

  async step(input: ActionModelInput, signal?: AbortSignal): Promise<unknown> {
    this.calls.push({ kind: "step", prompt: input.prompt, schema: input.schema });
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const next = this.stepScript.shift();
    if (next === undefined) throw new Error("no scripted step answer");
    if (next instanceof Error) throw next;
    return next;
  }
}

export interface ConnectorCall {
  toolId: string;
  args: Record<string, unknown>;
}

export function scriptedConnector(answers: Record<string, { text?: string; links?: { label: string; url: string | null; id: string | null }[] }>) {
  const calls: ConnectorCall[] = [];
  return {
    calls,
    status(_integration: IntegrationId) {
      return "connected" as const;
    },
    available(_toolId: string) {
      return true;
    },
    async call(toolId: string, args: Record<string, unknown>, _signal?: AbortSignal) {
      calls.push({ toolId, args });
      const hit = answers[toolId];
      return { text: hit?.text ?? "ok", links: hit?.links ?? [] };
    },
  };
}

export function installFakeActionModel(model: ActionModel): void {
  resetBudget();
  resetLimiterForTests();
  resetJobsForTests();
  resetReadSlotsForTests();
  resetIntegrationHealthForTests();
  setConnectorForTests(null);
  resetSuggestCacheForTests();
  setPageFetcherForTests(async () => ({ text: null, reason: "error", truncated: false }));
  setActionModelForTests(model);
}

export function restoreActionModel(): void {
  setActionModelForTests(null);
  setPageFetcherForTests(null);
  resetJobsForTests();
  resetIntegrationHealthForTests();
  setConnectorForTests(null);
  resetSuggestCacheForTests();
  setActionJobLimitMsForTests(null);
  setToolExecute("list_workspace_tabs", executeListTabs);
  setToolExecute("append_plan_items", executeAppendPlan);
  setToolExecute("github_create_issue", integrationExecute("github_create_issue"));
}

export async function runAndWait(work: () => Promise<unknown>): Promise<void> {
  await work();
  await idle();
}

export async function postSuggest(token: string | null, workspaceId: string, body: unknown = {}) {
  return read(
    suggestPost(req("POST", `/api/workspaces/${workspaceId}/actions/suggest`, token, body), {
      params: Promise.resolve({ id: workspaceId }),
    }),
  );
}

export async function getActions(token: string | null, workspaceId: string) {
  return read(
    actionsGet(req("GET", `/api/workspaces/${workspaceId}/actions`, token), {
      params: Promise.resolve({ id: workspaceId }),
    }),
  );
}

export async function postRun(
  token: string | null,
  workspaceId: string,
  toolId: string,
  body: unknown = { args: {}, label: toolId },
) {
  return read(
    runPost(req("POST", `/api/workspaces/${workspaceId}/actions/${toolId}/run`, token, body), {
      params: Promise.resolve({ id: workspaceId, toolId }),
    }),
  );
}

export async function postIntent(
  token: string | null,
  workspaceId: string,
  runId: string,
  intentId: string,
  body: unknown,
) {
  return read(
    intentPost(req("POST", `/api/workspaces/${workspaceId}/actions/runs/${runId}/intents/${intentId}`, token, body), {
      params: Promise.resolve({ id: workspaceId, runId, intentId }),
    }),
  );
}

export async function postConfirm(token: string | null, workspaceId: string, runId: string, body: unknown) {
  return read(
    confirmPost(req("POST", `/api/workspaces/${workspaceId}/actions/runs/${runId}/confirm`, token, body), {
      params: Promise.resolve({ id: workspaceId, runId }),
    }),
  );
}

export async function postCancel(token: string | null, workspaceId: string, runId: string) {
  return read(
    cancelPost(req("POST", `/api/workspaces/${workspaceId}/actions/runs/${runId}/cancel`, token), {
      params: Promise.resolve({ id: workspaceId, runId }),
    }),
  );
}

export async function getExport(token: string | null, workspaceId: string, format: string) {
  const res = await exportGet(req("GET", `/api/workspaces/${workspaceId}/summary/export?format=${format}`, token), {
    params: Promise.resolve({ id: workspaceId }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body: buf, json: res.headers.get("content-type")?.includes("json") ? JSON.parse(buf.toString("utf8")) : null };
}
