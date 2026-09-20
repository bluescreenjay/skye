// Gathers what one run may use: ONE workspace's web tabs, plan items, and recent chat, all read
// with the person's id and the workspace id (nothing else is ever queried). Page text is added
// to the tabs later by the run. Nothing here logs.
import { query } from "../db";
import type { DbWorkspace } from "../map";
import { fitHistory } from "../chat/context";
import { recentTurns } from "../chat/messages";
import { listPlanItems } from "./plan-items";
import { MAX_PLAN_ITEMS, MAX_TABS_LISTED, TAB_EXCERPT_CHARS, TAB_TITLE_CHARS, TAB_URL_CHARS } from "./limits";
import { listQueries, listRefs, listSummary } from "../actions/notes";

export interface GatheredTab {
  id: string;
  title: string;
  /** The plain address shown to the model and stored in results (query string and fragment removed, cut for display). */
  url: string;
  /** The plain address to request when reading the page (not cut for display). */
  fetchUrl: string;
  /** The address had a query string or fragment that was removed. */
  trimmed: boolean;
  excerpt: string;
}

export interface Gathered {
  workspaceName: string;
  /** Web tabs in the workspace (not only the ones listed). */
  tabsTotal: number;
  tabs: GatheredTab[];
  plan: { text: string; done: boolean }[];
  chat: { role: "user" | "assistant"; content: string }[];
  summary: { text: string } | null;
  savedQueries: string[];
  refs: { quote: string; url: string }[];
}

/** The address without its query string or fragment: they carry tokens, magic links, and one-time actions. */
export function plainAddress(url: string): { plain: string; trimmed: boolean } {
  try {
    const parsed = new URL(url);
    const trimmed = parsed.search !== "" || parsed.hash !== "";
    parsed.search = "";
    parsed.hash = "";
    return { plain: parsed.toString(), trimmed };
  } catch {
    const plain = url.split(/[?#]/)[0];
    return { plain, trimmed: plain !== url };
  }
}

const cut = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

type TabRow = { title: string; url: string; snippet: string; total: string };

export async function gatherMaterial(userId: string, workspace: Pick<DbWorkspace, "id" | "name">): Promise<Gathered> {
  const tabs = await query<TabRow>(
    `SELECT title, url, snippet, count(*) OVER () AS total
     FROM tab_refs
     WHERE user_id = $1::uuid AND workspace_id = $2::uuid AND url ~* '^https?://'
     ORDER BY (chrome_tab_id IS NOT NULL) DESC, last_seen_at DESC, id
     LIMIT $3::int`,
    [userId, workspace.id, MAX_TABS_LISTED],
  );

  // Tabs that share a plain address are one entry: each distinct page is read, sent, and listed once.
  const seen = new Set<string>();
  const gathered: GatheredTab[] = [];
  for (const row of tabs.rows) {
    const { plain, trimmed } = plainAddress(row.url);
    if (seen.has(plain)) continue;
    seen.add(plain);
    gathered.push({
      id: `t${gathered.length + 1}`,
      title: cut(row.title, TAB_TITLE_CHARS),
      url: cut(plain, TAB_URL_CHARS),
      fetchUrl: plain,
      trimmed,
      excerpt: cut(row.snippet, TAB_EXCERPT_CHARS),
    });
  }

  const plan = (await listPlanItems(userId, workspace.id)).slice(0, MAX_PLAN_ITEMS).map((p) => ({ text: cut(p.text, 200), done: p.done }));
  const chat = fitHistory(
    (await recentTurns(userId, workspace.id, 20)).map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  );
  const [summary, savedQueries, refs] = await Promise.all([
    listSummary(userId, workspace.id),
    listQueries(userId, workspace.id),
    listRefs(userId, workspace.id),
  ]);

  return {
    workspaceName: cut(workspace.name, 200),
    tabsTotal: tabs.rows.length > 0 ? Number(tabs.rows[0].total) : 0,
    tabs: gathered,
    plan,
    chat,
    summary: summary ? { text: cut(summary.text, 1_200) } : null,
    savedQueries,
    refs: refs.map((ref) => ({ quote: cut(ref.quote, 300), url: cut(ref.url, 200) })),
  };
}
