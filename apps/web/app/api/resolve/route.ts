import { requireUser } from "@/src/auth";
import { query } from "@/src/db";
import { errorJson, json, optionsResponse } from "@/src/json";
import { mapTabRef, mapWorkspace, TAB_REF_COLUMNS, type DbTabRef, type DbWorkspace } from "@/src/map";

export const runtime = "nodejs";

export function OPTIONS() {
  return optionsResponse();
}

export async function GET(request: Request) {
  const { user, error } = await requireUser(request);
  if (error) return error;

  const params = new URL(request.url).searchParams;
  const chromeTabIdRaw = params.get("chromeTabId");
  const url = params.get("url");
  if (!chromeTabIdRaw && !url) {
    return errorJson("chromeTabId or url is required", 400);
  }

  let tabRow = null;

  if (chromeTabIdRaw) {
    const chromeTabId = Number(chromeTabIdRaw);
    if (!Number.isInteger(chromeTabId)) {
      return errorJson("chromeTabId must be an integer", 400);
    }
    const byChrome = await query<DbTabRef>(
      `SELECT ${TAB_REF_COLUMNS}
       FROM tab_refs WHERE user_id = $1 AND chrome_tab_id = $2`,
      [user!.id, chromeTabId],
    );
    tabRow = byChrome.rows[0] ?? null;
  }

  if (!tabRow && url) {
    const byUrl = await query<DbTabRef>(
      `SELECT ${TAB_REF_COLUMNS}
       FROM tab_refs WHERE user_id = $1 AND url = $2
       ORDER BY last_seen_at DESC LIMIT 1`,
      [user!.id, url],
    );
    tabRow = byUrl.rows[0] ?? null;
  }

  if (!tabRow) {
    return json({ workspace: null, tabRef: null });
  }

  const tabRef = mapTabRef(tabRow);
  if (!tabRef.workspaceId) {
    return json({ workspace: null, tabRef });
  }

  const ws = await query<DbWorkspace>(
    `SELECT id, user_id, name, emoji, status, created_at, updated_at
     FROM workspaces WHERE id = $1 AND user_id = $2`,
    [tabRef.workspaceId, user!.id],
  );
  const workspace = ws.rows[0] ? mapWorkspace(ws.rows[0]) : null;
  return json({ workspace, tabRef });
}
