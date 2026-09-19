// Helpers for the clustering tests: a fake model (no network, ever), a gate that
// holds a model call open, and seeding through the real ingest and workspace routes.
import { POST as ingestPost } from "@/app/api/ingest/tabs/route";
import { GET as tabRefsGet } from "@/app/api/tab-refs/route";
import { POST as workspacesPost } from "@/app/api/workspaces/route";
import { setModelForTests, type ClusterModel, type ClusterModelInput } from "@/src/cluster/model";
import { resetForTests as resetBudget } from "@/src/llm/budget";
import { batch, read, req, tab } from "./helpers";

export interface FakeModel extends ClusterModel {
  /** The input of every call, in order. */
  calls: ClusterModelInput[];
}

type Handler = (input: ClusterModelInput, callNumber: number) => unknown[] | Promise<unknown[]>;

/**
 * A model that answers with whatever `handler` returns (raw groups, exactly as the
 * real model would, so the validator gets exercised) or throws whatever it throws.
 */
export function fakeModel(handler: Handler): FakeModel {
  const calls: ClusterModelInput[] = [];
  return {
    calls,
    async propose(input) {
      calls.push(input);
      return { groups: await handler(input, calls.length) };
    },
  };
}

/** Installs a fake model for the current test and resets the daily budget. */
export function installFakeModel(handler: Handler): FakeModel {
  resetBudget();
  const model = fakeModel(handler);
  setModelForTests(model);
  return model;
}

/** Call in afterEach: puts the real model (which has no key in tests) back. */
export function restoreModel(): void {
  setModelForTests(null);
  resetBudget();
}

/** A promise a test releases later, to hold a fake model call open (overlapping runs). */
export function gate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

export interface SeedTab {
  url: string;
  title?: string;
  snippet?: string;
}

let nextChromeTabId = 1000;

/** Adds tabs for a user through the real ingest route. Returns the tab refs as stored. */
export async function seedTabs(token: string, tabs: SeedTab[]) {
  const body = batch({
    tabs: tabs.map((t) =>
      tab(nextChromeTabId++, t.url, { title: t.title ?? `Title of ${t.url}`, snippet: t.snippet ?? `Text about ${t.url}` }),
    ),
  });
  const reply = await read(ingestPost(req("POST", "/api/ingest/tabs", token, body)));
  if (reply.status !== 200) throw new Error(`seedTabs failed: ${reply.status} ${JSON.stringify(reply.json)}`);
  return listTabs(token);
}

/** Every tab ref this user has. */
export async function listTabs(token: string) {
  return (await read(tabRefsGet(req("GET", "/api/tab-refs", token)))).json.tabRefs as {
    id: string;
    url: string;
    title: string;
    workspaceId: string | null;
    placementSource: "ai" | "user" | null;
    chromeTabId: number | null;
  }[];
}

/** Creates a workspace by hand (the way a user does). */
export async function makeWorkspace(token: string, name: string, emoji: string | null = null) {
  const reply = await read(workspacesPost(req("POST", "/api/workspaces", token, { name, emoji })));
  if (reply.status !== 201 && reply.status !== 200) throw new Error(`makeWorkspace failed: ${reply.status}`);
  return reply.json.workspace as { id: string; name: string; status: string; updatedAt: string; createdAt: string };
}

/** The short ids ("t1", ...) the model was given for tabs whose URL contains any of `fragments`. */
export function idsFor(input: ClusterModelInput, ...fragments: string[]): string[] {
  return input.tabs.filter((t) => fragments.some((f) => t.url.includes(f))).map((t) => t.id);
}

/** A raw group as the model would return it. */
export function group(
  name: string,
  tabIds: string[],
  confidence = 0.9,
  extra: { emoji?: string | null; existingWorkspaceId?: string | null } = {},
) {
  return { name, emoji: extra.emoji === undefined ? "📁" : extra.emoji, confidence, existingWorkspaceId: extra.existingWorkspaceId ?? null, tabIds };
}
