// Applies one batch from the tab-ingestion extension
// (contract: specs/002-tab-ingestion-extension/contracts/ingest-api.md).
//
// Tab identity is the address, not Chrome's tab id. Chrome's ids only last for one
// browser session, so a record is matched by (user, url); the tab id is stored only
// as the record's *live* binding and is cleared whenever it stops being true.
//
// Type-only imports from @ai-browser/shared: a runtime import from the workspace
// package would need `transpilePackages` in next.config.ts.
import { randomUUID } from "crypto";
import type { PoolClient } from "pg";
import type { IngestBatchRequest, IngestBatchResponse, IngestEventType } from "@ai-browser/shared";

export const MAX_EVENTS = 100;
export const MAX_TABS = 500;
export const MAX_BODY_BYTES = 1_000_000;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 2000;
const SNIPPET_LIMIT = 2000; // SNIPPET_MAX_LENGTH in @ai-browser/shared
const EVENT_TYPES: IngestEventType[] = ["opened", "updated", "activated", "closed"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParseResult =
  | { ok: true; batch: IngestBatchRequest }
  | { ok: false; status: 400 | 413; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

function isWebUrl(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_URL_LENGTH) return false;
  try {
    const { protocol } = new URL(v);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Validates the body without trusting it. A bad item is a 400 naming the item; a too-large batch is a 413. */
export function parseBatch(raw: unknown): ParseResult {
  const bad = (error: string): ParseResult => ({ ok: false, status: 400, error });
  if (!isObject(raw)) return bad("body must be a JSON object");
  if (typeof raw.batchId !== "string" || raw.batchId === "") return bad("batchId is required");
  if (!isIso(raw.sentAt)) return bad("sentAt must be an ISO-8601 time");
  if (typeof raw.fullSnapshot !== "boolean") return bad("fullSnapshot must be a boolean");
  if (!isObject(raw.active)) return bad("active is required");
  if (!Array.isArray(raw.tabs)) return bad("tabs must be an array");
  if (!Array.isArray(raw.events)) return bad("events must be an array");
  if (raw.tabs.length > MAX_TABS) return { ok: false, status: 413, error: `at most ${MAX_TABS} tabs per request` };
  if (raw.events.length > MAX_EVENTS) return { ok: false, status: 413, error: `at most ${MAX_EVENTS} events per request` };

  const active = raw.active;
  const okId = (v: unknown) => v === null || isInt(v);
  if (!okId(active.windowId) || !okId(active.chromeTabId)) return bad("active must hold integer or null ids");

  for (const [i, t] of raw.tabs.entries()) {
    if (!isObject(t)) return bad(`tabs[${i}] must be an object`);
    if (!isInt(t.chromeTabId)) return bad(`tabs[${i}].chromeTabId must be an integer`);
    if (!isInt(t.windowId)) return bad(`tabs[${i}].windowId must be an integer`);
    if (typeof t.active !== "boolean") return bad(`tabs[${i}].active must be a boolean`);
    if (!isWebUrl(t.url)) return bad(`tabs[${i}].url must be an http(s) address of at most ${MAX_URL_LENGTH} characters`);
    if (typeof t.title !== "string") return bad(`tabs[${i}].title must be a string`);
    if (typeof t.snippet !== "string") return bad(`tabs[${i}].snippet must be a string`);
    if (!isIso(t.lastSeenAt)) return bad(`tabs[${i}].lastSeenAt must be an ISO-8601 time`);
  }

  for (const [i, e] of raw.events.entries()) {
    if (!isObject(e)) return bad(`events[${i}] must be an object`);
    if (typeof e.id !== "string" || !UUID.test(e.id)) return bad(`events[${i}].id must be a UUID`);
    if (!isIso(e.time)) return bad(`events[${i}].time must be an ISO-8601 time`);
    if (!isInt(e.chromeTabId)) return bad(`events[${i}].chromeTabId must be an integer`);
    if (!isWebUrl(e.url)) return bad(`events[${i}].url must be an http(s) address of at most ${MAX_URL_LENGTH} characters`);
    if (typeof e.title !== "string") return bad(`events[${i}].title must be a string`);
    if (typeof e.eventType !== "string" || !EVENT_TYPES.includes(e.eventType as IngestEventType)) {
      return bad(`events[${i}].eventType must be one of ${EVENT_TYPES.join(", ")}`);
    }
  }
  return { ok: true, batch: raw as unknown as IngestBatchRequest };
}

type TabRow = { id: string; workspace_id: string | null; chrome_tab_id: number | null; last_seen_at: Date };

/**
 * The record for a page: the one already bound to this tab id if there is one,
 * otherwise the most recently seen. Two tabs on the same page share one record.
 */
async function findByUrl(client: PoolClient, userId: string, url: string, chromeTabId: number): Promise<TabRow | null> {
  const result = await client.query<TabRow>(
    `SELECT id, workspace_id, chrome_tab_id, last_seen_at FROM tab_refs
     WHERE user_id = $1 AND url = $2
     ORDER BY (chrome_tab_id IS NOT DISTINCT FROM $3) DESC, last_seen_at DESC
     LIMIT 1`,
    [userId, url, chromeTabId],
  );
  return result.rows[0] ?? null;
}

/** A browser tab id belongs to one live tab, so no other record of this user may hold it. */
async function releaseTabId(client: PoolClient, userId: string, chromeTabId: number, exceptId: string) {
  await client.query(
    "UPDATE tab_refs SET chrome_tab_id = NULL WHERE user_id = $1 AND chrome_tab_id = $2 AND id <> $3",
    [userId, chromeTabId, exceptId],
  );
}

export async function applyBatch(client: PoolClient, userId: string, batch: IngestBatchRequest): Promise<IngestBatchResponse> {
  // One batch at a time per user, so concurrent devices cannot interleave.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [userId]);

  // 1. Snapshots: what each open tab looks like now.
  const matched: string[] = [];
  for (const tab of batch.tabs) {
    const title = tab.title.slice(0, MAX_TITLE_LENGTH);
    const snippet = tab.snippet.slice(0, SNIPPET_LIMIT);
    const seenAt = new Date(Math.min(Date.parse(tab.lastSeenAt), Date.now()));
    const existing = await findByUrl(client, userId, tab.url, tab.chromeTabId);

    let id: string;
    if (existing) {
      id = existing.id;
      await releaseTabId(client, userId, tab.chromeTabId, id);
      // An empty snippet means "could not read", so it never overwrites a stored one.
      await client.query(
        `UPDATE tab_refs
         SET title = $1,
             snippet = CASE WHEN $2 = '' THEN snippet ELSE $2 END,
             chrome_tab_id = $3,
             last_seen_at = GREATEST(last_seen_at, $4)
         WHERE id = $5 AND user_id = $6`,
        [title, snippet, tab.chromeTabId, seenAt, id, userId],
      );
    } else {
      id = randomUUID();
      await releaseTabId(client, userId, tab.chromeTabId, id);
      await client.query(
        `INSERT INTO tab_refs (id, user_id, workspace_id, url, title, snippet, chrome_tab_id, last_seen_at)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7)`,
        [id, userId, tab.url, title, snippet, tab.chromeTabId, seenAt],
      );
    }
    matched.push(id);
  }

  // 2. A full snapshot lists every open tab: any record not in it is no longer live.
  if (batch.fullSnapshot) {
    await client.query(
      `UPDATE tab_refs SET chrome_tab_id = NULL
       WHERE user_id = $1 AND chrome_tab_id IS NOT NULL AND NOT (id = ANY($2::uuid[]))`,
      [userId, matched],
    );
  }

  // 3. Events, in order. Each id is stored once, so a retried batch adds nothing new.
  let accepted = 0;
  let duplicates = 0;
  for (const event of batch.events) {
    const row = await findByUrl(client, userId, event.url, event.chromeTabId);
    const time = new Date(event.time);
    const inserted = await client.query(
      `INSERT INTO tab_events (time, id, user_id, tab_ref_id, chrome_tab_id, url, title, workspace_id, event_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (time, id) DO NOTHING`,
      [time, event.id, userId, row?.id ?? null, event.chromeTabId, event.url, event.title.slice(0, MAX_TITLE_LENGTH), row?.workspace_id ?? null, event.eventType],
    );
    if (inserted.rowCount === 0) {
      duplicates += 1;
      continue;
    }
    accepted += 1;

    // The tab is gone: release its id, unless the record was seen again after this event.
    if (event.eventType === "closed" && row && row.chrome_tab_id === event.chromeTabId && time >= row.last_seen_at) {
      await client.query(
        "UPDATE tab_refs SET chrome_tab_id = NULL WHERE id = $1 AND user_id = $2 AND chrome_tab_id = $3",
        [row.id, userId, event.chromeTabId],
      );
    }
  }

  return { accepted, duplicates };
}
