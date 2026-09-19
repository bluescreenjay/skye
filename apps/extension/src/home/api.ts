import type { TabRef, Workspace } from "@ai-browser/shared";
import { loadConfig } from "../config";
import {
  createWorkspace as createWorkspaceWrite,
  moveTab as moveTabWrite,
  renameWorkspace as renameWorkspaceWrite,
} from "../corrections/api";
import { mapClusterHttpResult, type OrganizeOutcome } from "./organize";

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function emptyDirectory(): { workspaces: Workspace[]; tabRefs: TabRef[] } {
  return { workspaces: [], tabRefs: [] };
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export async function loadDirectory(): Promise<{ workspaces: Workspace[]; tabRefs: TabRef[] }> {
  const result = loadConfig(import.meta.env);
  if (!result.ok) return emptyDirectory();

  try {
    const headers = authHeaders(result.config.deviceToken);
    const [workspacesResponse, tabRefsResponse] = await Promise.all([
      fetch(`${result.config.apiBaseUrl}/api/workspaces`, { headers }),
      fetch(`${result.config.apiBaseUrl}/api/tab-refs`, { headers }),
    ]);
    if (!workspacesResponse.ok || !tabRefsResponse.ok) return emptyDirectory();

    const workspacesBody = await readJson<{ workspaces?: Workspace[] }>(workspacesResponse);
    const tabRefsBody = await readJson<{ tabRefs?: TabRef[] }>(tabRefsResponse);
    return {
      workspaces: workspacesBody?.workspaces ?? [],
      tabRefs: tabRefsBody?.tabRefs ?? [],
    };
  } catch {
    return emptyDirectory();
  }
}

export async function renameWorkspace(id: string, name: string): Promise<Workspace | null> {
  const result = await renameWorkspaceWrite(id, name);
  return result.ok ? result.value : null;
}

export async function moveTab(id: string, workspaceId: string | null): Promise<TabRef | null> {
  const result = await moveTabWrite(id, workspaceId);
  return result.ok ? result.value : null;
}

export async function createWorkspace(name: string, emoji?: string | null): Promise<Workspace | null> {
  const result = await createWorkspaceWrite(name, emoji);
  return result.ok ? result.value : null;
}

/** POST /api/cluster/runs then map to Home organize outcome. Does not invent directory rows. */
export async function runCluster(): Promise<OrganizeOutcome> {
  const result = loadConfig(import.meta.env);
  if (!result.ok) {
    return mapClusterHttpResult(401, { error: result.reason });
  }

  try {
    const response = await fetch(`${result.config.apiBaseUrl}/api/cluster/runs`, {
      method: "POST",
      headers: authHeaders(result.config.deviceToken),
      body: JSON.stringify({}),
    });
    const body = await readJson<unknown>(response);
    return mapClusterHttpResult(response.status, body);
  } catch {
    return mapClusterHttpResult(0, null);
  }
}
