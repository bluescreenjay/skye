import type { TabRef, Workspace } from "@ai-browser/shared";
import { loadConfig, type Config } from "../config";

export type WriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "unpaired" | "bad_name" | "failed" };

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function withConfig(): { ok: true; config: Config } | { ok: false; reason: "unpaired" } {
  const result = loadConfig(import.meta.env);
  if (!result.ok) return { ok: false, reason: "unpaired" };
  return { ok: true, config: result.config };
}

/** POST /api/workspaces — create a named workspace for the paired person. */
export async function createWorkspace(
  name: string,
  emoji?: string | null,
): Promise<WriteResult<Workspace>> {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 80) return { ok: false, reason: "bad_name" };
  const cfg = withConfig();
  if (!cfg.ok) return cfg;

  try {
    const body: { name: string; emoji?: string } = { name: trimmed.toLowerCase() };
    if (emoji) body.emoji = emoji;
    const response = await fetch(`${cfg.config.apiBaseUrl}/api/workspaces`, {
      method: "POST",
      headers: authHeaders(cfg.config.deviceToken),
      body: JSON.stringify(body),
    });
    if (response.status === 400) return { ok: false, reason: "bad_name" };
    if (!response.ok) return { ok: false, reason: "failed" };
    const json = await readJson<{ workspace?: Workspace }>(response);
    if (!json?.workspace) return { ok: false, reason: "failed" };
    return { ok: true, value: json.workspace };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** PATCH /api/workspaces/:id — rename. */
export async function renameWorkspace(id: string, name: string): Promise<WriteResult<Workspace>> {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 80) return { ok: false, reason: "bad_name" };
  const cfg = withConfig();
  if (!cfg.ok) return cfg;

  try {
    const response = await fetch(`${cfg.config.apiBaseUrl}/api/workspaces/${id}`, {
      method: "PATCH",
      headers: authHeaders(cfg.config.deviceToken),
      body: JSON.stringify({ name: trimmed.toLowerCase() }),
    });
    if (response.status === 400) return { ok: false, reason: "bad_name" };
    if (!response.ok) return { ok: false, reason: "failed" };
    const json = await readJson<{ workspace?: Workspace }>(response);
    if (!json?.workspace) return { ok: false, reason: "failed" };
    return { ok: true, value: json.workspace };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** PATCH /api/workspaces/:id — archive (hide from Home; data kept). */
export async function archiveWorkspace(id: string): Promise<WriteResult<Workspace>> {
  const cfg = withConfig();
  if (!cfg.ok) return cfg;

  try {
    const response = await fetch(`${cfg.config.apiBaseUrl}/api/workspaces/${id}`, {
      method: "PATCH",
      headers: authHeaders(cfg.config.deviceToken),
      body: JSON.stringify({ status: "archived" }),
    });
    if (!response.ok) return { ok: false, reason: "failed" };
    const json = await readJson<{ workspace?: Workspace }>(response);
    if (!json?.workspace) return { ok: false, reason: "failed" };
    return { ok: true, value: json.workspace };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** PATCH /api/tab-refs/:id — move to a workspace or Other (`null`). */
export async function moveTab(id: string, workspaceId: string | null): Promise<WriteResult<TabRef>> {
  const cfg = withConfig();
  if (!cfg.ok) return cfg;

  try {
    const response = await fetch(`${cfg.config.apiBaseUrl}/api/tab-refs/${id}`, {
      method: "PATCH",
      headers: authHeaders(cfg.config.deviceToken),
      body: JSON.stringify({ workspaceId }),
    });
    if (!response.ok) return { ok: false, reason: "failed" };
    const json = await readJson<{ tabRef?: TabRef }>(response);
    if (!json?.tabRef) return { ok: false, reason: "failed" };
    return { ok: true, value: json.tabRef };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** PUT /api/tab-refs — upsert by URL and set membership (for pages not yet saved). */
export async function putTabMembership(
  url: string,
  title: string,
  chromeTabId: number | null,
  workspaceId: string | null,
): Promise<WriteResult<TabRef>> {
  const cfg = withConfig();
  if (!cfg.ok) return cfg;

  try {
    const response = await fetch(`${cfg.config.apiBaseUrl}/api/tab-refs`, {
      method: "PUT",
      headers: authHeaders(cfg.config.deviceToken),
      body: JSON.stringify({ url, title, chromeTabId, workspaceId }),
    });
    if (!response.ok) return { ok: false, reason: "failed" };
    const json = await readJson<{ tabRef?: TabRef }>(response);
    if (!json?.tabRef) return { ok: false, reason: "failed" };
    return { ok: true, value: json.tabRef };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** GET /api/workspaces — destinations for sidebar moves. */
export async function listWorkspaces(): Promise<WriteResult<Workspace[]>> {
  const cfg = withConfig();
  if (!cfg.ok) return cfg;

  try {
    const response = await fetch(`${cfg.config.apiBaseUrl}/api/workspaces`, {
      headers: authHeaders(cfg.config.deviceToken),
    });
    if (!response.ok) return { ok: false, reason: "failed" };
    const json = await readJson<{ workspaces?: Workspace[] }>(response);
    return { ok: true, value: json?.workspaces ?? [] };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** POST /api/suggestions/:id/ignore — dismiss without membership change. */
export async function ignoreSuggestion(id: string): Promise<WriteResult<{ id: string; status: string }>> {
  const cfg = withConfig();
  if (!cfg.ok) return cfg;

  try {
    const response = await fetch(`${cfg.config.apiBaseUrl}/api/suggestions/${id}/ignore`, {
      method: "POST",
      headers: authHeaders(cfg.config.deviceToken),
      body: "{}",
    });
    if (!response.ok) return { ok: false, reason: "failed" };
    const json = await readJson<{ suggestion?: { id: string; status: string } }>(response);
    if (!json?.suggestion) return { ok: false, reason: "failed" };
    return { ok: true, value: json.suggestion };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** GET /api/suggestions?status=pending — for sidebar dismiss UI. */
export async function listPendingSuggestions(): Promise<WriteResult<Array<{ id: string; tabRefIds: string[] }>>> {
  const cfg = withConfig();
  if (!cfg.ok) return cfg;

  try {
    const response = await fetch(`${cfg.config.apiBaseUrl}/api/suggestions?status=pending`, {
      headers: authHeaders(cfg.config.deviceToken),
    });
    if (!response.ok) return { ok: false, reason: "failed" };
    const json = await readJson<{ suggestions?: Array<{ id: string; tabRefIds?: string[] }> }>(response);
    const list = (json?.suggestions ?? []).map((item) => ({
      id: item.id,
      tabRefIds: item.tabRefIds ?? [],
    }));
    return { ok: true, value: list };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
