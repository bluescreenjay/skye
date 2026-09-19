import { randomUUID } from "crypto";
import type { TabEventType } from "@ai-browser/shared";
import { requireUser } from "@/src/auth";
import { query } from "@/src/db";
import { errorJson, json, optionsResponse } from "@/src/json";
import { mapTabEvent, type DbTabEvent } from "@/src/map";

export const runtime = "nodejs";

const EVENT_TYPES: TabEventType[] = [
  "opened",
  "updated",
  "activated",
  "closed",
  "reassigned",
];

export function OPTIONS() {
  return optionsResponse();
}

export async function GET(request: Request) {
  const { user, error } = await requireUser(request);
  if (error) return error;

  const raw = new URL(request.url).searchParams.get("limit");
  let limit = 50;
  if (raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) return errorJson("limit must be a positive integer", 400);
    limit = Math.min(n, 200);
  }

  const result = await query<DbTabEvent>(
    `SELECT time, id, user_id, tab_ref_id, chrome_tab_id, url, title, workspace_id, event_type
     FROM tab_events WHERE user_id = $1 ORDER BY time DESC LIMIT $2`,
    [user!.id, limit],
  );
  return json({ tabEvents: result.rows.map(mapTabEvent) });
}

export async function POST(request: Request) {
  const { user, error } = await requireUser(request);
  if (error) return error;

  let body: {
    eventType?: unknown;
    url?: unknown;
    title?: unknown;
    chromeTabId?: unknown;
    tabRefId?: unknown;
    workspaceId?: unknown;
    time?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return errorJson("Invalid JSON", 400);
  }

  if (typeof body.eventType !== "string" || !EVENT_TYPES.includes(body.eventType as TabEventType)) {
    return errorJson("invalid eventType", 400);
  }

  const url = typeof body.url === "string" ? body.url : "";
  const title = typeof body.title === "string" ? body.title : "";
  const chromeTabId =
    typeof body.chromeTabId === "number" && Number.isInteger(body.chromeTabId)
      ? body.chromeTabId
      : null;
  const tabRefId = typeof body.tabRefId === "string" ? body.tabRefId : null;
  const workspaceId =
    body.workspaceId === null || body.workspaceId === undefined
      ? null
      : typeof body.workspaceId === "string"
        ? body.workspaceId
        : null;

  if (tabRefId) {
    const owns = await query(
      "SELECT 1 FROM tab_refs WHERE id = $1 AND user_id = $2",
      [tabRefId, user!.id],
    );
    if (!owns.rows[0]) return errorJson("tabRefId not found", 400);
  }

  const id = randomUUID();
  const time =
    typeof body.time === "string" && !Number.isNaN(Date.parse(body.time))
      ? new Date(body.time)
      : new Date();

  const result = await query<DbTabEvent>(
    `INSERT INTO tab_events (time, id, user_id, tab_ref_id, chrome_tab_id, url, title, workspace_id, event_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING time, id, user_id, tab_ref_id, chrome_tab_id, url, title, workspace_id, event_type`,
    [time, id, user!.id, tabRefId, chromeTabId, url, title, workspaceId, body.eventType],
  );
  return json({ tabEvent: mapTabEvent(result.rows[0]) }, 201);
}
