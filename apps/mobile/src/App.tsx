import { useCallback, useEffect, useState } from "react";
import type { Message, TabRef, Workspace } from "@ai-browser/shared";
import { ApiError, approveAction, ask, askProjects, browserSpeak, cancelAction, directory, getProposal, history, listActions, prepareAction, projectHistory, redeem, sendAction, synthesize, token, type ProjectMessage, type Proposal } from "./api";
import { VoiceInput } from "./VoiceInput";
import { VoiceConversation } from "./VoiceConversation";

type Route = { page: "pair" } | { page: "directory" } | { page: "workspace"; id: string } | { page: "projects" };
const routeOf = (): Route => {
  if (location.pathname === "/pair") return { page: "pair" };
  if (location.pathname === "/projects") return { page: "projects" };
  const match = location.pathname.match(/^\/w\/([^/]+)$/);
  return match ? { page: "workspace", id: decodeURIComponent(match[1]) } : { page: "directory" };
};
function go(path: string) { window.history.pushState(null, "", path); window.dispatchEvent(new Event("popstate")); }

function AnswerAudio({ text }: { text: string }) {
  const [audioUrl, setAudioUrl] = useState(""); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  const listen = async () => { if (loading) return; setLoading(true); setError(""); try { const blob = await synthesize(text); if (audioUrl) URL.revokeObjectURL(audioUrl); setAudioUrl(URL.createObjectURL(blob)); } catch (caught) { if (caught instanceof ApiError && caught.status === 402) { try { await browserSpeak(text); } catch (fallbackError) { setError(fallbackError instanceof Error ? fallbackError.message : "Could not play answer"); } } else setError(caught instanceof Error ? caught.message : "Could not play answer"); } finally { setLoading(false); } };
  return <div className="answer-audio"><button type="button" className="quiet" onClick={() => void listen()} disabled={loading}>{loading ? "preparing audio…" : "🔊 listen"}</button>{audioUrl && <audio controls src={audioUrl} preload="none" />}{error && <small className="error" role="alert">{error}</small>}</div>;
}

export function App() {
  const [route, setRoute] = useState(routeOf);
  useEffect(() => { const update = () => setRoute(routeOf()); addEventListener("popstate", update); return () => removeEventListener("popstate", update); }, []);
  useEffect(() => { if (!token() && route.page !== "pair") go("/pair"); }, [route.page]);
  return <main className="mobile-shell">{route.page === "pair" ? <Pair /> : route.page === "directory" ? <Directory open={(id) => go(`/w/${id}`)} /> : route.page === "projects" ? <ProjectsPage /> : <WorkspacePage id={route.id} back={() => go("/")} />}</main>;
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
  return <section><header><div><p className="eyebrow">skye</p><h1>Your workspaces</h1></div><button className="quiet" onClick={() => void refresh()}>refresh</button></header><button className="workspace-card" onClick={() => go("/projects")}>✦ Ask across all projects</button>{data.workspaces.length === 0 && other.length === 0 ? <p className="empty">No workspaces yet. Organize pages from desktop and they’ll appear here.</p> : <div className="workspace-list">{data.workspaces.map((workspace) => <button className="workspace-card" key={workspace.id} onClick={() => open(workspace.id)}><span>{workspace.emoji ?? "◌"}</span><strong>{workspace.name}</strong><small>{data.tabRefs.filter((tab) => tab.workspaceId === workspace.id).length} pages</small></button>)}{other.length > 0 && <article className="other"><strong>Other</strong><span>{other.length} unassigned pages</span></article>}</div>}</section>;
}

function WorkspacePage({ id, back }: { id: string; back: () => void }) {
  const [data, setData] = useState<{ workspaces: Workspace[]; tabRefs: TabRef[] }>(); const [messages, setMessages] = useState<Message[]>([]); const [draft, setDraft] = useState(""); const [error, setError] = useState(""); const [sending, setSending] = useState(false);
  const load = useCallback(async () => { try { const [next, chat] = await Promise.all([directory(), history(id)]); setData(next); setMessages(chat.messages); } catch (e) { if (e instanceof ApiError && e.status === 401) go("/pair"); else setError("Could not load this workspace."); } }, [id]);
  useEffect(() => { void load(); }, [load]);
  const submit = async (event: React.FormEvent) => { event.preventDefault(); const message = draft.trim(); if (!message || sending) return; setSending(true); setError(""); try { const response = await ask(id, message); setMessages((current) => [...current, response.userMessage, response.assistantMessage]); setDraft(""); } catch (e) { if (e instanceof ApiError && e.status === 401) go("/pair"); else setError(e instanceof Error ? e.message : "Message could not be sent"); } finally { setSending(false); } };
  const workspace = data?.workspaces.find((item) => item.id === id); const pages = data?.tabRefs.filter((item) => item.workspaceId === id) ?? [];
  return <section><button className="back" onClick={back}>← workspaces</button><h1>{workspace?.name ?? "Workspace"}</h1>{error && <p className="error">{error}</p>}<h2>Pages</h2><div className="pages">{pages.length ? pages.map((page) => <a key={page.id} href={page.url} target="_blank" rel="noreferrer">{page.title || page.url}<small>{page.url}</small></a>) : <p className="empty">No saved pages in this workspace.</p>}</div><h2>Conversation</h2><div className="messages">{messages.length ? messages.map((message) => <article key={message.id} className={`message ${message.role}`}><span>{message.role === "assistant" ? "skye" : "you"}</span>{message.content}{message.role === "assistant" && <><AnswerAudio text={message.content} /><ActionEntry sourceScope="workspace" sourceId={message.id} workspaceId={id} /></>}</article>) : <p className="empty">Ask about this workspace to begin.</p>}</div><form className="composer" onSubmit={submit}><textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask about this workspace" rows={2} /><VoiceConversation ask={(text) => ask(id, text).then((response) => response.assistantMessage)} onAnswer={(answer) => setMessages((current) => [...current, { ...answer, id: crypto.randomUUID(), role: "assistant" } as Message])} disabled={sending} /><VoiceInput onText={(text) => setDraft((current) => `${current} ${text}`.trim())} disabled={sending} /><button disabled={sending || !draft.trim()}>{sending ? "sending…" : "send"}</button></form></section>;
}

function ProjectsPage() {
  const [messages, setMessages] = useState<ProjectMessage[]>([]); const [draft, setDraft] = useState(""); const [error, setError] = useState(""); const [sending, setSending] = useState(false);
  const [actions, setActions] = useState<Proposal[]>([]);
  useEffect(() => { void projectHistory().then((data) => setMessages(data.messages)).catch(() => setError("Could not load project history.")); }, []);
  useEffect(() => { void listActions().then((data) => setActions(data.proposals)).catch(() => undefined); }, []);
  const submit = async (event: React.FormEvent) => { event.preventDefault(); const message = draft.trim(); if (!message || sending) return; setSending(true); setError(""); try { const result = await askProjects(message); setMessages((current) => [...current, result.userMessage, result.assistantMessage]); setDraft(""); } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not answer that question"); } finally { setSending(false); } };
  return <section><button className="back" onClick={() => go("/")}>← workspaces</button><h1>All projects</h1><p>Ask across your saved workspaces. Open a source to continue in that workspace.</p>{error && <p className="error" role="alert">{error}</p>}<div className="messages">{messages.map((message) => <article className={`message ${message.role}`} key={message.id}><span>{message.role === "assistant" ? "skye" : "you"}</span>{message.content}{message.role === "assistant" && <AnswerAudio text={message.content} />}{message.coverage && <small className="coverage">Checked {message.coverage.checked} of {message.coverage.total} projects{message.coverage.omitted ? `; ${message.coverage.omitted} omitted` : ""}.</small>}{message.citations.length > 0 && <div className="citations">{message.citations.map((citation) => <button type="button" className="quiet" key={citation.workspaceId} onClick={() => go(`/w/${citation.workspaceId}`)}>{citation.workspaceName} ↗</button>)}</div>}{message.role === "assistant" && <ActionEntry sourceScope="project" sourceId={message.id} />}</article>)}</div>{actions.length > 0 && <><h2>Recent actions</h2>{actions.map((action) => <ActionReview key={action.id} proposal={action} update={(next) => setActions((current) => current.map((item) => item.id === next.id ? next : item))} />)}</>}<form className="composer" onSubmit={submit}><textarea rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Ask about all projects" /><VoiceConversation ask={(text) => askProjects(text).then((response) => response.assistantMessage)} onAnswer={(answer) => setMessages((current) => [...current, { ...answer, id: crypto.randomUUID(), role: "assistant", citations: [], coverage: null, createdAt: new Date().toISOString() }])} disabled={sending} /><VoiceInput onText={(text) => setDraft((current) => `${current} ${text}`.trim())} disabled={sending} /><button disabled={!draft.trim() || sending}>{sending ? "asking…" : "ask"}</button></form></section>;
}

function ActionEntry({ sourceScope, sourceId, workspaceId }: { sourceScope: "project" | "workspace"; sourceId: string; workspaceId?: string }) {
  const [request, setRequest] = useState(""); const [proposal, setProposal] = useState<Proposal | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const prepare = async () => { if (!request.trim()) return; setBusy(true); setError(""); try { const response = await prepareAction({ request, sourceScope, sourceId, workspaceId }); setProposal(response.proposal); } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not prepare action"); } finally { setBusy(false); } };
  useEffect(() => { if (!proposal || proposal.state !== "running") return; const timer = setInterval(() => { void getProposal(proposal.id).then((value) => setProposal(value.proposal)).catch(() => undefined); }, 2500); return () => clearInterval(timer); }, [proposal]);
  return <div className="action-entry"><input aria-label="Action for this answer" placeholder="Make a Notion page for that…" value={request} onChange={(event) => setRequest(event.target.value)} /><button type="button" className="quiet" disabled={busy || !request.trim()} onClick={() => void prepare()}>prepare action</button>{error && <small className="error" role="alert">{error}</small>}{proposal && <ActionReview proposal={proposal} update={setProposal} />}</div>;
}

function ActionReview({ proposal, update }: { proposal: Proposal; update: (next: Proposal) => void }) {
  const [title, setTitle] = useState(proposal.title); const [body, setBody] = useState(proposal.body); const [recipient, setRecipient] = useState(proposal.recipient ?? ""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const act = async (call: () => Promise<{ proposal: Proposal }>) => { setBusy(true); setError(""); try { update((await call()).proposal); } catch (caught) { setError(caught instanceof Error ? caught.message : "Action failed"); } finally { setBusy(false); } };
  const result = proposal.result as { links?: { label: string; url: string | null }[] } | null;
  return <div className="action-review"><strong>{proposal.toolId === "notion_create_page" ? "Review Notion page" : "Review email"}</strong><p>Source: {proposal.sourceScope === "project" ? "All projects" : "This workspace"}</p><p>Destination: {proposal.toolId === "notion_create_page" ? proposal.destination ?? "Notion is not connected" : recipient || "Enter your email address"}</p>{proposal.state === "proposed" ? <><label>Title or subject<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>{proposal.toolId === "gmail_send_message" && <label>Recipient<input type="email" value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="you@example.com" /></label>}<label>Full content<textarea rows={8} value={body} onChange={(event) => setBody(event.target.value)} /></label><button type="button" disabled={busy} onClick={() => void act(() => approveAction(proposal.id, { title, body, recipient }))}>{proposal.toolId === "notion_create_page" ? "Create page" : "Prepare email"}</button><button type="button" className="quiet" disabled={busy} onClick={() => void act(() => cancelAction(proposal.id))}>cancel</button></> : <><p>Status: {proposal.state.replaceAll("_", " ")}</p>{proposal.state === "ready_to_send" && <><p>To: {proposal.recipient}<br />Subject: {proposal.title}</p><pre>{proposal.body}</pre><button type="button" disabled={busy} onClick={() => void act(() => sendAction(proposal.id))}>Send email</button></>}{result?.links?.map((link) => link.url && <a key={link.url} href={link.url} target="_blank" rel="noreferrer">{link.label}</a>)}</>}<button type="button" className="quiet" onClick={() => void navigator.clipboard.writeText(body).catch(() => setError("Could not copy content"))}>copy content</button>{error && <small className="error" role="alert">{error}</small>}</div>;
}
