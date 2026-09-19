import type { TabRef, Workspace } from "@ai-browser/shared";
import { loadConfig } from "../config";

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
  const result = loadConfig(import.meta.env);
  if (!result.ok) return null;

  try {
    const response = await fetch(`${result.config.apiBaseUrl}/api/workspaces/${id}`, {
      method: "PATCH",
      headers: authHeaders(result.config.deviceToken),
      body: JSON.stringify({ name }),
    });
    if (!response.ok) return null;
    const body = await readJson<{ workspace?: Workspace }>(response);
    return body?.workspace ?? null;
  } catch {
    return null;
  }
}

export async function moveTab(id: string, workspaceId: string | null): Promise<TabRef | null> {
  const result = loadConfig(import.meta.env);
  if (!result.ok) return null;

  try {
    const response = await fetch(`${result.config.apiBaseUrl}/api/tab-refs/${id}`, {
      method: "PATCH",
      headers: authHeaders(result.config.deviceToken),
      body: JSON.stringify({ workspaceId }),
    });
    if (!response.ok) return null;
    const body = await readJson<{ tabRef?: TabRef }>(response);
    return body?.tabRef ?? null;
  } catch {
    return null;
  }
}
