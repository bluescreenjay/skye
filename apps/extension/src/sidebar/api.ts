import type { TabRef, Workspace } from "@ai-browser/shared";
import type { Config } from "../config";
import type { ActivePage, PanelView } from "./state";

type ResolveBody = { workspace?: Workspace | null; tabRef?: TabRef | null };
type TabRefsBody = { tabRefs?: TabRef[] };

function headers(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** Read the server's assignment and saved members; never writes placement. */
export async function fetchPanelView(
  page: ActivePage,
  config: Config,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<PanelView> {
  const options = { headers: headers(config.deviceToken), signal };
  const resolveUrl = new URL("/api/resolve", config.apiBaseUrl);
  resolveUrl.searchParams.set("chromeTabId", String(page.tabId));
  resolveUrl.searchParams.set("url", page.url);

  try {
    const response = await fetchImpl(resolveUrl.toString(), options);
    if (!response.ok) {
      return { kind: "unavailable", message: response.status === 401 ? "pairing needed" : "workspace unavailable" };
    }
    let resolved = await readJson<ResolveBody>(response);
    if (!resolved || !("tabRef" in resolved)) {
      return { kind: "unavailable", message: "workspace unavailable" };
    }

    // Ingestion can lag behind a navigation. The live tab ID may still point
    // at the previous URL for a moment; never show that page's workspace.
    if (resolved.tabRef && resolved.tabRef.url !== page.url) {
      const byUrl = new URL("/api/resolve", config.apiBaseUrl);
      byUrl.searchParams.set("url", page.url);
      const currentResponse = await fetchImpl(byUrl.toString(), options);
      if (!currentResponse.ok) {
        return { kind: "unavailable", message: currentResponse.status === 401 ? "pairing needed" : "workspace unavailable" };
      }
      resolved = await readJson<ResolveBody>(currentResponse);
      if (!resolved || !("tabRef" in resolved) || (resolved.tabRef && resolved.tabRef.url !== page.url)) {
        return { kind: "unavailable", message: "workspace unavailable" };
      }
    }

    const workspace = resolved.workspace ?? null;
    const tabRef = resolved.tabRef ?? null;
    if (workspace && (workspace.status === "archived" || !tabRef || tabRef.workspaceId !== workspace.id)) {
      return { kind: "unavailable", message: "workspace unavailable" };
    }
    if (!workspace && tabRef?.workspaceId) {
      return { kind: "unavailable", message: "workspace unavailable" };
    }

    const membersUrl = new URL("/api/tab-refs", config.apiBaseUrl);
    if (workspace) membersUrl.searchParams.set("workspaceId", workspace.id);
    else membersUrl.searchParams.set("other", "true");
    const membersResponse = await fetchImpl(membersUrl.toString(), options);
    if (!membersResponse.ok) {
      return { kind: "unavailable", message: membersResponse.status === 401 ? "pairing needed" : "workspace unavailable" };
    }
    const body = await readJson<TabRefsBody>(membersResponse);
    if (!Array.isArray(body?.tabRefs)) {
      return { kind: "unavailable", message: "workspace unavailable" };
    }
    const tabs = body.tabRefs.filter((item) => item.workspaceId === (workspace?.id ?? null));
    return workspace ? { kind: "named", page, workspace, tabs } : { kind: "other", page, tabs };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: "unavailable", message: "could not reach workspace" };
  }
}
