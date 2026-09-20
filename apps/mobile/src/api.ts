import type { ChatHistoryPage, Message, TabRef, Workspace } from "@ai-browser/shared";

const TOKEN_KEY = "ai-browser.mobile.device-token";
const baseUrl = String(import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");

export const token = () => localStorage.getItem(TOKEN_KEY);
export const forgetToken = () => localStorage.removeItem(TOKEN_KEY);
export const saveToken = (value: string) => localStorage.setItem(TOKEN_KEY, value);

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const credential = token();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Accept: "application/json", ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) {
    if (response.status === 401) forgetToken();
    throw new ApiError(body?.error ?? "Could not reach your workspaces", response.status);
  }
  return body as T;
}

export async function redeem(code: string, label?: string) {
  const response = await fetch(`${baseUrl}/api/pairing/redeem`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ code, label }) });
  const body = await response.json().catch(() => null) as { deviceToken?: string; error?: string } | null;
  if (!response.ok || !body?.deviceToken) throw new ApiError(body?.error ?? "Pairing failed", response.status);
  saveToken(body.deviceToken);
}

export async function directory() {
  const [workspaces, tabs] = await Promise.all([
    request<{ workspaces: Workspace[] }>("/api/workspaces"),
    request<{ tabRefs: TabRef[] }>("/api/tab-refs"),
  ]);
  return { workspaces: workspaces.workspaces, tabRefs: tabs.tabRefs };
}

export const history = (workspaceId: string) => request<ChatHistoryPage>(`/api/workspaces/${encodeURIComponent(workspaceId)}/chat`);
export const ask = (workspaceId: string, message: string) => request<{ userMessage: Message; assistantMessage: Message }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/chat`, { method: "POST", body: JSON.stringify({ message, stream: false }) });
