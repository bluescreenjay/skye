import { query } from "../db";
import { stripUrl } from "../cluster/prompt";

export interface ProjectCitation { workspaceId: string; workspaceName: string; title: string; url?: string }
export interface ProjectCoverage { checked: number; total: number; omitted: number }

type WorkspaceRow = { id: string; name: string; status: string; updated_at: Date; summary: string | null; tab_count: string; plan_count: string };
type TabRow = { title: string; url: string; snippet: string };
type PlanRow = { text: string; done: boolean };
type AgentRow = { action_id: string; output: unknown };
type MessageRow = { role: string; content: string };

const INDEX_LIMIT = 100;
const DETAIL_LIMIT = 12;

export async function buildProjectContext(userId: string, question: string): Promise<{ data: string; citations: ProjectCitation[]; coverage: ProjectCoverage }> {
  const rows = await query<WorkspaceRow>(
    `SELECT w.id, w.name, w.status, w.updated_at,
       (SELECT body FROM workspace_notes WHERE user_id = w.user_id AND workspace_id = w.id AND kind = 'summary' ORDER BY updated_at DESC LIMIT 1) AS summary,
       (SELECT count(*)::text FROM tab_refs WHERE user_id = w.user_id AND workspace_id = w.id) AS tab_count,
       (SELECT count(*)::text FROM plan_items WHERE user_id = w.user_id AND workspace_id = w.id) AS plan_count
     FROM workspaces w WHERE w.user_id = $1::uuid ORDER BY w.updated_at DESC, w.id LIMIT $2`,
    [userId, INDEX_LIMIT],
  );
  const totalResult = await query<{ total: string }>("SELECT count(*)::text AS total FROM workspaces WHERE user_id = $1::uuid", [userId]);
  const total = Number(totalResult.rows[0]?.total ?? 0);
  const words = question.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2);
  const ranked = rows.rows.map((row) => ({ row, score: words.filter((word) => `${row.name} ${row.summary ?? ""}`.toLowerCase().includes(word)).length }));
  ranked.sort((a, b) => b.score - a.score || b.row.updated_at.getTime() - a.row.updated_at.getTime() || a.row.id.localeCompare(b.row.id));
  const chosen = ranked.slice(0, DETAIL_LIMIT).map(({ row }) => row);
  const citations: ProjectCitation[] = [];
  const details = [];
  for (const workspace of chosen) {
    const [tabs, plan, agents, conversation] = await Promise.all([
      query<TabRow>("SELECT title, url, snippet FROM tab_refs WHERE user_id = $1::uuid AND workspace_id = $2::uuid ORDER BY last_seen_at DESC, id LIMIT 5", [userId, workspace.id]),
      query<PlanRow>("SELECT text, done FROM plan_items WHERE user_id = $1::uuid AND workspace_id = $2::uuid ORDER BY sort_order, id LIMIT 8", [userId, workspace.id]),
      query<AgentRow>("SELECT action_id, output FROM action_runs WHERE user_id = $1::uuid AND workspace_id = $2::uuid AND status = 'succeeded' AND action_id IN ('summarize', 'compare', 'missing', 'next_steps', 'collect_refs') ORDER BY created_at DESC LIMIT 2", [userId, workspace.id]),
      query<MessageRow>("SELECT role, content FROM messages WHERE user_id = $1::uuid AND workspace_id = $2::uuid AND role IN ('user', 'assistant') ORDER BY created_at DESC, id DESC LIMIT 4", [userId, workspace.id]),
    ]);
    citations.push({ workspaceId: workspace.id, workspaceName: workspace.name, title: workspace.name });
    details.push({
      id: workspace.id,
      name: workspace.name.slice(0, 80),
      status: workspace.status,
      summary: workspace.summary?.slice(0, 800) ?? null,
      tabCount: Number(workspace.tab_count),
      planCount: Number(workspace.plan_count),
      tabs: tabs.rows.map((tab) => ({ title: tab.title.slice(0, 160), url: stripUrl(tab.url).slice(0, 200), excerpt: tab.snippet.slice(0, 250) })),
      plan: plan.rows.map((item) => ({ text: item.text.slice(0, 200), done: item.done })),
      recentAgentResults: agents.rows.map((agent) => ({ agent: agent.action_id, result: JSON.stringify(agent.output).slice(0, 500) })),
      recentConversation: conversation.rows.reverse().map((message) => ({ role: message.role, text: message.content.slice(0, 350) })),
    });
  }
  const coverage = { checked: chosen.length, total, omitted: Math.max(0, total - chosen.length) };
  return { data: JSON.stringify({ workspaces: details, coverage }), citations, coverage };
}
