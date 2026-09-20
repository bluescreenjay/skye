import { randomUUID } from "crypto";
import { query } from "../db";
import { getTool } from "../actions/registry";
import { validateArgs, isValidRecipient } from "../actions/args";
import { connectionStatus, integrationConfig, isOwner } from "../actions/integrations/config";
import { getConnector } from "../actions/integrations/connector";
import { startToolRun } from "../actions/run";
import { readToolRun } from "../actions/runs";
import { confirmSend } from "../actions/confirm";
import { findWorkspace } from "../chat/messages";

export type ProposalState = "proposed" | "running" | "ready_to_send" | "succeeded" | "failed" | "cancelled" | "expired";
export interface Proposal { id: string; sourceScope: "project" | "workspace"; sourceId: string; workspaceId: string | null; toolId: "notion_create_page" | "gmail_send_message"; destination: string | null; title: string; body: string; recipient: string | null; state: ProposalState; result: unknown; runId: string | null; expiresAt: string }
type Row = { id: string; source_scope: Proposal["sourceScope"]; source_id: string; workspace_id: string | null; tool_id: Proposal["toolId"]; title: string; body: string; recipient: string | null; state: ProposalState; result: unknown; run_id: string | null; expires_at: Date };
const map = (r: Row): Proposal => ({ id: r.id, sourceScope: r.source_scope, sourceId: r.source_id, workspaceId: r.workspace_id, toolId: r.tool_id, destination: r.tool_id === "notion_create_page" ? integrationConfig("notion").destination : r.recipient, title: r.title, body: r.body, recipient: r.recipient, state: r.state, result: r.result, runId: r.run_id, expiresAt: r.expires_at.toISOString() });
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export class ProposalError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function source(userId: string, scope: unknown, sourceId: unknown, workspaceId: unknown): Promise<{ content: string; workspaceId: string | null; name: string }> {
  if (!uuid(sourceId)) throw new ProposalError(400, "Choose an answer first");
  if (scope === "project") {
    const found = await query<{ content: string; citations: { workspaceId?: string; workspaceName?: string }[] }>("SELECT content, citations FROM project_messages WHERE id = $1::uuid AND user_id = $2::uuid AND role = 'assistant'", [sourceId, userId]);
    if (!found.rows[0]) throw new ProposalError(404, "Answer not found");
    const citations = Array.isArray(found.rows[0].citations) ? found.rows[0].citations : [];
    const sources = citations.slice(0, 12).filter((item) => uuid(item.workspaceId)).map((item) => `- ${String(item.workspaceName ?? "Workspace").slice(0, 80)} (${item.workspaceId})`);
    return { content: `${found.rows[0].content}${sources.length ? `\n\nSources:\n${sources.join("\n")}` : ""}`, workspaceId: null, name: "All projects" };
  }
  if (scope === "workspace" && uuid(workspaceId)) {
    const workspace = await findWorkspace(userId, workspaceId);
    if (!workspace) throw new ProposalError(404, "Workspace not found");
    const found = await query<{ content: string }>("SELECT content FROM messages WHERE id = $1::uuid AND user_id = $2::uuid AND workspace_id = $3::uuid AND role = 'assistant'", [sourceId, userId, workspaceId]);
    if (!found.rows[0]) throw new ProposalError(404, "Answer not found");
    return { content: found.rows[0].content, workspaceId, name: workspace.name };
  }
  throw new ProposalError(400, "Choose an answer first");
}

export async function createProposal(userId: string, body: unknown): Promise<Proposal> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ProposalError(400, "Invalid request");
  const input = body as Record<string, unknown>;
  const request = typeof input.request === "string" ? input.request.trim().toLowerCase() : "";
  const toolId = /notion|page/.test(request) ? "notion_create_page" : /email|mail/.test(request) ? "gmail_send_message" : null;
  if (!toolId) throw new ProposalError(400, "Ask to create a Notion page or email this answer");
  const selected = await source(userId, input.sourceScope, input.sourceId, input.workspaceId);
  if (selected.content.length > 8_000) throw new ProposalError(400, "Answer is too long to share");
  const tool = getTool(toolId)!;
  const title = toolId === "notion_create_page" ? `${selected.name} notes` : `${selected.name} update`;
  const args = validateArgs(tool, { title: title.slice(0, 200), content: selected.content, subject: title.slice(0, 200), body: selected.content });
  const id = randomUUID();
  const result = await query<Row>(
    `INSERT INTO action_proposals (id, user_id, source_scope, source_id, workspace_id, tool_id, title, body)
     VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7, $8)
     RETURNING *`,
    [id, userId, input.sourceScope, input.sourceId, selected.workspaceId, toolId, title, String(args.content ?? args.body)],
  );
  return map(result.rows[0]);
}

export async function readProposal(userId: string, id: string): Promise<Proposal> {
  if (!uuid(id)) throw new ProposalError(404, "Proposal not found");
  const result = await query<Row>("SELECT * FROM action_proposals WHERE id = $1::uuid AND user_id = $2::uuid", [id, userId]);
  if (!result.rows[0]) throw new ProposalError(404, "Proposal not found");
  const proposal = map(result.rows[0]);
  if (proposal.state === "proposed" && Date.parse(proposal.expiresAt) < Date.now()) {
    await query("UPDATE action_proposals SET state = 'expired' WHERE id = $1::uuid AND user_id = $2::uuid AND state = 'proposed'", [id, userId]);
    proposal.state = "expired";
  }
  return proposal;
}

export async function listProposals(userId: string): Promise<Proposal[]> {
  const result = await query<Row>("SELECT * FROM action_proposals WHERE user_id = $1::uuid ORDER BY created_at DESC, id DESC LIMIT 30", [userId]);
  return result.rows.map(map);
}

export async function cancelProposal(userId: string, id: string): Promise<Proposal> {
  await query("UPDATE action_proposals SET state = 'cancelled' WHERE id = $1::uuid AND user_id = $2::uuid AND state = 'proposed'", [id, userId]);
  return readProposal(userId, id);
}

export async function approveProposal(userId: string, id: string, input: unknown): Promise<Proposal> {
  const current = await readProposal(userId, id);
  if (current.state !== "proposed") throw new ProposalError(409, "This proposal was already handled");
  if (Date.parse(current.expiresAt) < Date.now()) throw new ProposalError(409, "This proposal expired");
  const values = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const title = typeof values.title === "string" ? values.title.trim() : current.title;
  const content = typeof values.body === "string" ? values.body.trim() : current.body;
  const recipient = typeof values.recipient === "string" ? values.recipient.trim() : "";
  const tool = getTool(current.toolId)!;
  const args = current.toolId === "notion_create_page" ? { title, content } : { subject: title, body: content, to: recipient };
  validateArgs(tool, args);
  if (current.toolId === "gmail_send_message" && (!isOwner(userId) || !isValidRecipient(recipient))) throw new ProposalError(400, "Enter and confirm a valid recipient address");
  const service = current.toolId === "notion_create_page" ? "notion" : "gmail";
  if (connectionStatus(service) !== "connected") throw new ProposalError(409, `Connect ${service} to use this action`);
  const locked = await query<Row>("UPDATE action_proposals SET state = 'running', title = $3, body = $4, recipient = $5 WHERE id = $1::uuid AND user_id = $2::uuid AND state = 'proposed' RETURNING *", [id, userId, title, content, recipient || null]);
  if (!locked.rows[0]) throw new ProposalError(409, "This proposal was already handled");
  try {
    if (current.workspaceId) {
      const workspace = await findWorkspace(userId, current.workspaceId);
      if (!workspace) throw new ProposalError(404, "Workspace not found");
      const started = await startToolRun(userId, workspace, current.toolId, { args, label: title });
      await query("UPDATE action_proposals SET run_id = $3::uuid, state = 'running' WHERE id = $1::uuid AND user_id = $2::uuid", [id, userId, started.run.id]);
    } else if (current.toolId === "notion_create_page") {
      const result = await tool.execute({ userId, workspaceId: "", workspaceName: "All projects", args, signal: AbortSignal.timeout(20_000) });
      await query("UPDATE action_proposals SET state = 'succeeded', result = $3::jsonb WHERE id = $1::uuid AND user_id = $2::uuid", [id, userId, JSON.stringify(result)]);
    } else {
      await query("UPDATE action_proposals SET state = 'ready_to_send' WHERE id = $1::uuid AND user_id = $2::uuid", [id, userId]);
    }
  } catch {
    await query("UPDATE action_proposals SET state = 'failed' WHERE id = $1::uuid AND user_id = $2::uuid", [id, userId]);
  }
  return readProposal(userId, id);
}

export async function refreshProposal(userId: string, id: string): Promise<Proposal> {
  const proposal = await readProposal(userId, id);
  if (proposal.runId && proposal.workspaceId && proposal.state === "running") {
    const run = await readToolRun(userId, proposal.workspaceId, proposal.runId);
    if (run?.state === "succeeded" || run?.state === "failed") {
      const nextState = proposal.toolId === "gmail_send_message" && run.state === "succeeded" ? "ready_to_send" : run.state;
      await query("UPDATE action_proposals SET state = $3, result = $4::jsonb WHERE id = $1::uuid AND user_id = $2::uuid AND state = 'running'", [id, userId, nextState, JSON.stringify(run.output ?? run.error)]);
      return readProposal(userId, id);
    }
  }
  return proposal;
}

export async function sendProposal(userId: string, id: string): Promise<Proposal> {
  const proposal = await readProposal(userId, id);
  if (proposal.toolId !== "gmail_send_message" || proposal.state !== "ready_to_send" || !proposal.recipient) throw new ProposalError(409, "Email is not ready to send");
  if (!isOwner(userId) || connectionStatus("gmail") !== "connected") throw new ProposalError(409, "Gmail is unavailable");
  const locked = await query("UPDATE action_proposals SET state = 'running' WHERE id = $1::uuid AND user_id = $2::uuid AND state = 'ready_to_send' RETURNING id", [id, userId]);
  if (!locked.rowCount) throw new ProposalError(409, "Email is already being sent");
  try {
    if (proposal.runId && proposal.workspaceId) {
      const run = await confirmSend(userId, proposal.workspaceId, proposal.runId, proposal.recipient);
      await query("UPDATE action_proposals SET state = $3, result = $4::jsonb WHERE id = $1::uuid AND user_id = $2::uuid", [id, userId, run.state === "succeeded" ? "succeeded" : "failed", JSON.stringify(run.output ?? run.error)]);
    } else {
      const result = await getConnector().call("gmail_send_message", { to: proposal.recipient, subject: proposal.title, body: proposal.body }, AbortSignal.timeout(15_000));
      await query("UPDATE action_proposals SET state = 'succeeded', result = $3::jsonb WHERE id = $1::uuid AND user_id = $2::uuid", [id, userId, JSON.stringify({ links: result.links })]);
    }
  } catch {
    await query("UPDATE action_proposals SET state = 'failed' WHERE id = $1::uuid AND user_id = $2::uuid", [id, userId]);
  }
  return readProposal(userId, id);
}
