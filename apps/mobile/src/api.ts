import type { ChatHistoryPage, Message, TabRef, Workspace } from "@ai-browser/shared";

export interface ProjectCitation { workspaceId: string; workspaceName: string; title: string; url?: string }
export interface ProjectMessage { id: string; role: "user" | "assistant"; content: string; citations: ProjectCitation[]; coverage: { checked: number; total: number; omitted: number } | null; createdAt: string }
export interface Proposal { id: string; sourceScope: "project" | "workspace"; sourceId: string; workspaceId: string | null; toolId: "notion_create_page" | "gmail_send_message"; destination: string | null; title: string; body: string; recipient: string | null; state: "proposed" | "running" | "ready_to_send" | "succeeded" | "failed" | "cancelled" | "expired"; result: unknown; runId: string | null; expiresAt: string }

const TOKEN_KEY = "ai-browser.mobile.device-token";
const baseUrl = String(import.meta.env.VITE_API_BASE_URL ?? `${location.protocol}//${location.hostname}:3000`).replace(/\/+$/, "");

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
export const projectHistory = () => request<{ messages: ProjectMessage[] }>("/api/projects/chat");
export const askProjects = (message: string) => request<{ userMessage: ProjectMessage; assistantMessage: ProjectMessage }>("/api/projects/chat", { method: "POST", body: JSON.stringify({ message }) });
export const prepareAction = (input: { request: string; sourceScope: "project" | "workspace"; sourceId: string; workspaceId?: string }) => request<{ proposal: Proposal }>("/api/action-proposals", { method: "POST", body: JSON.stringify(input) });
export const listActions = () => request<{ proposals: Proposal[] }>("/api/action-proposals");
export const getProposal = (id: string) => request<{ proposal: Proposal }>(`/api/action-proposals/${encodeURIComponent(id)}`);
export const approveAction = (id: string, input: { title: string; body: string; recipient?: string }) => request<{ proposal: Proposal }>(`/api/action-proposals/${encodeURIComponent(id)}/approve`, { method: "POST", body: JSON.stringify(input) });
export const cancelAction = (id: string) => request<{ proposal: Proposal }>(`/api/action-proposals/${encodeURIComponent(id)}/cancel`, { method: "POST" });
export const sendAction = (id: string) => request<{ proposal: Proposal }>(`/api/action-proposals/${encodeURIComponent(id)}/send`, { method: "POST" });
export async function transcribe(audio: Blob): Promise<string> {
  const credential = token();
  const form = new FormData();
  form.set("audio", audio, "question.webm");
  const response = await fetch(`${baseUrl}/api/voice/transcribe`, { method: "POST", headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body: form });
  const result = await response.json().catch(() => null) as { text?: string; error?: string } | null;
  if (!response.ok || !result?.text) throw new ApiError(result?.error ?? "Could not transcribe audio", response.status);
  return result.text;
}

export async function synthesize(text: string): Promise<Blob> {
  const credential = token();
  const response = await fetch(`${baseUrl}/api/voice/synthesize`, { method: "POST", headers: { Accept: "audio/mpeg", "Content-Type": "application/json", ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify({ text }) });
  if (!response.ok) { const result = await response.json().catch(() => null) as { error?: string } | null; throw new ApiError(result?.error ?? "Could not create voice playback", response.status); }
  return response.blob();
}

export function browserSpeak(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!("speechSynthesis" in window)) { reject(new Error("Browser speech is unavailable")); return; }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => resolve(); utterance.onerror = () => reject(new Error("Browser speech failed"));
    window.speechSynthesis.cancel(); window.speechSynthesis.speak(utterance);
  });
}
