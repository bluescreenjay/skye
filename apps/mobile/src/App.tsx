import { useCallback, useEffect, useState } from "react";
import type { Message, TabRef, Workspace } from "@ai-browser/shared";
import { ApiError, ask, directory, history, redeem, token } from "./api";

type Route = { page: "pair" } | { page: "directory" } | { page: "workspace"; id: string };
const routeOf = (): Route => {
  if (location.pathname === "/pair") return { page: "pair" };
  const match = location.pathname.match(/^\/w\/([^/]+)$/);
  return match ? { page: "workspace", id: decodeURIComponent(match[1]) } : { page: "directory" };
};
function go(path: string) { window.history.pushState(null, "", path); window.dispatchEvent(new Event("popstate")); }

export function App() {
  const [route, setRoute] = useState(routeOf);
  useEffect(() => { const update = () => setRoute(routeOf()); addEventListener("popstate", update); return () => removeEventListener("popstate", update); }, []);
  useEffect(() => { if (!token() && route.page !== "pair") go("/pair"); }, [route.page]);
  return <main className="mobile-shell">{route.page === "pair" ? <Pair /> : route.page === "directory" ? <Directory open={(id) => go(`/w/${id}`)} /> : <WorkspacePage id={route.id} back={() => go("/")} />}</main>;
}

function Pair() {
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get("code") ?? "");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setBusy(true); setError(""); try { await redeem(code); go("/"); } catch (caught) { setError(caught instanceof Error ? caught.message : "Pairing failed"); } finally { setBusy(false); } };
  return <section className="pair"><p className="eyebrow">skye companion</p><h1>Bring your workspaces with you.</h1><p>On desktop, choose <em>pair phone</em>, then enter the eight-character code here.</p><form onSubmit={submit}><label>Pairing code<input autoCapitalize="characters" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD1234" /></label><button disabled={busy || !code.trim()}>{busy ? "pairing…" : "pair phone"}</button></form>{error && <p className="error" role="alert">{error}</p>}</section>;
}

function Directory({ open }: { open: (id: string) => void }) {
  const [data, setData] = useState<{ workspaces: Workspace[]; tabRefs: TabRef[] }>(); const [error, setError] = useState("");
  const refresh = useCallback(() => directory().then(setData).catch((e: unknown) => { if (e instanceof ApiError && e.status === 401) go("/pair"); else setError("Could not refresh your workspaces."); }), []);
  useEffect(() => { void refresh(); }, [refresh]);
  if (!data) return <p className="loading">{error || "Loading workspaces…"}</p>;
  const other = data.tabRefs.filter((tab) => tab.workspaceId === null);
  return <section><header><div><p className="eyebrow">skye</p><h1>Your workspaces</h1></div><button className="quiet" onClick={() => void refresh()}>refresh</button></header>{data.workspaces.length === 0 && other.length === 0 ? <p className="empty">No workspaces yet. Organize pages from desktop and they’ll appear here.</p> : <div className="workspace-list">{data.workspaces.map((workspace) => <button className="workspace-card" key={workspace.id} onClick={() => open(workspace.id)}><span>{workspace.emoji ?? "◌"}</span><strong>{workspace.name}</strong><small>{data.tabRefs.filter((tab) => tab.workspaceId === workspace.id).length} pages</small></button>)}{other.length > 0 && <article className="other"><strong>Other</strong><span>{other.length} unassigned pages</span></article>}</div>}</section>;
}

function WorkspacePage({ id, back }: { id: string; back: () => void }) {
  const [data, setData] = useState<{ workspaces: Workspace[]; tabRefs: TabRef[] }>(); const [messages, setMessages] = useState<Message[]>([]); const [draft, setDraft] = useState(""); const [error, setError] = useState(""); const [sending, setSending] = useState(false);
  const load = useCallback(async () => { try { const [next, chat] = await Promise.all([directory(), history(id)]); setData(next); setMessages(chat.messages); } catch (e) { if (e instanceof ApiError && e.status === 401) go("/pair"); else setError("Could not load this workspace."); } }, [id]);
  useEffect(() => { void load(); }, [load]);
  const submit = async (event: React.FormEvent) => { event.preventDefault(); const message = draft.trim(); if (!message || sending) return; setSending(true); setError(""); try { const response = await ask(id, message); setMessages((current) => [...current, response.userMessage, response.assistantMessage]); setDraft(""); } catch (e) { if (e instanceof ApiError && e.status === 401) go("/pair"); else setError(e instanceof Error ? e.message : "Message could not be sent"); } finally { setSending(false); } };
  const workspace = data?.workspaces.find((item) => item.id === id); const pages = data?.tabRefs.filter((item) => item.workspaceId === id) ?? [];
  return <section><button className="back" onClick={back}>← workspaces</button><h1>{workspace?.name ?? "Workspace"}</h1>{error && <p className="error">{error}</p>}<h2>Pages</h2><div className="pages">{pages.length ? pages.map((page) => <a key={page.id} href={page.url} target="_blank" rel="noreferrer">{page.title || page.url}<small>{page.url}</small></a>) : <p className="empty">No saved pages in this workspace.</p>}</div><h2>Conversation</h2><div className="messages">{messages.length ? messages.map((message) => <article key={message.id} className={`message ${message.role}`}><span>{message.role === "assistant" ? "skye" : "you"}</span>{message.content}</article>) : <p className="empty">Ask about this workspace to begin.</p>}</div><form className="composer" onSubmit={submit}><textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask about this workspace" rows={2} /><button disabled={sending || !draft.trim()}>{sending ? "sending…" : "send"}</button></form></section>;
}
