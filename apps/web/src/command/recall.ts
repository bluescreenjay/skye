// "What was I working on yesterday?" (specs/011-global-command-bar/research.md 10; spec FR-016). Plain SQL over
// the recorded `tab_events` (no continuous aggregate: the (user_id, time DESC) index makes one day or week
// small, and it would not exist on the pivot database). Read-only. A tab counts once per `opened` or
// `activated` event in the period: that is the person opening or switching to it. `updated` (page loads,
// title changes), `closed`, and `reassigned` (written by organize, moves, and undo) are never activity, and
// only web addresses count. Nothing here writes, fetches, or logs.
import type { RecalledWorkspace } from "@ai-browser/shared";
import type { Db } from "./context";
import { MAX_RECALLED_TABS, MAX_RECALLED_WORKSPACES } from "./limits";

interface TabRow {
  workspace_id: string | null;
  url: string;
  title: string;
  visits: string;
  last_time: Date;
}

export async function recallActivity(db: Db, userId: string, range: { start: Date; end: Date }): Promise<RecalledWorkspace[]> {
  // One row per tab (its record, else its address) per workspace snapshot, with its visits and latest title.
  const result = await db.query<TabRow>(
    `SELECT e.workspace_id,
            (array_agg(e.url ORDER BY e.time DESC))[1] AS url,
            (array_agg(e.title ORDER BY e.time DESC))[1] AS title,
            count(*) AS visits,
            max(e.time) AS last_time
     FROM tab_events e
     WHERE e.user_id = $1::uuid AND e.time >= $2::timestamptz AND e.time < $3::timestamptz
       AND e.event_type IN ('opened', 'activated') AND e.url ~* '^https?://'
     GROUP BY e.workspace_id, COALESCE(e.tab_ref_id::text, e.url)`,
    [userId, range.start.toISOString(), range.end.toISOString()],
  );

  const byWorkspace = new Map<string | null, { visits: number; last: number; tabs: (TabRow & { n: number })[] }>();
  for (const row of result.rows) {
    const entry = byWorkspace.get(row.workspace_id) ?? { visits: 0, last: 0, tabs: [] };
    const n = Number(row.visits);
    entry.visits += n;
    entry.last = Math.max(entry.last, new Date(row.last_time).getTime());
    entry.tabs.push({ ...row, n });
    byWorkspace.set(row.workspace_id, entry);
  }

  // The workspace's CURRENT name and state: `tab_events.workspace_id` is a snapshot with no foreign key.
  const ids = [...byWorkspace.keys()].filter((id): id is string => id !== null);
  const known = new Map<string, { name: string; status: string }>();
  if (ids.length > 0) {
    const rows = await db.query<{ id: string; name: string; status: string }>(`SELECT id, name, status FROM workspaces WHERE user_id = $1::uuid AND id = ANY($2::uuid[])`, [userId, ids]);
    for (const r of rows.rows) known.set(r.id, { name: r.name, status: r.status });
  }

  const out: (RecalledWorkspace & { last: number })[] = [];
  for (const [workspaceId, entry] of byWorkspace) {
    if (workspaceId !== null && !known.has(workspaceId)) continue; // a workspace that no longer exists is left out
    const info = workspaceId === null ? null : known.get(workspaceId)!;
    const tabs = entry.tabs
      .sort((a, b) => b.n - a.n || new Date(b.last_time).getTime() - new Date(a.last_time).getTime())
      .slice(0, MAX_RECALLED_TABS)
      .map((t) => ({ title: t.title, url: t.url, visits: t.n }));
    out.push({
      workspaceId,
      name: info ? info.name : "Other",
      linkable: info !== null && info.status !== "archived", // Other and an archived workspace have no card to open
      visits: entry.visits,
      tabs,
      last: entry.last,
    });
  }
  return out
    .sort((a, b) => b.visits - a.visits || b.last - a.last)
    .slice(0, MAX_RECALLED_WORKSPACES)
    .map(({ last: _last, ...workspace }) => workspace);
}
