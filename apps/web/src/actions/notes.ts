// workspace_notes: the saved summary, saved queries, and saved references
// (specs/010b-mcp-action-tools/data-model.md). Every query filters by user_id AND workspace id.
import { randomUUID } from "crypto";
import { query, withTransaction } from "../db";
import { normalizeForMatch } from "../agents/validate";
import { SAVED_QUERIES_MAX, SAVED_REFS_MAX, SUMMARY_CHARS } from "./limits";

export type NoteKind = "summary" | "query" | "ref";

export interface SummaryCoverage {
  tabsTotal: number;
  tabsIncluded: number;
  pagesRead: number;
}

export interface SavedSummary {
  text: string;
  updatedAt: string;
  coverage: SummaryCoverage;
  unreadable: number;
}

export interface SaveCount {
  added: number;
  skippedDuplicates: number;
  refused: number;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function dedupeKey(kind: NoteKind, body: string, url?: string | null): string {
  if (kind === "summary") return "current";
  const folded = normalizeForMatch(body);
  return kind === "ref" ? `${folded}\n${url ?? ""}` : folded;
}

type NoteRow = {
  id: string;
  body: string;
  url: string | null;
  meta: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
};

export async function upsertSummary(
  userId: string,
  workspaceId: string,
  text: string,
  meta: { coverage: SummaryCoverage; unreadable: number; cited?: { title: string; url: string }[] },
): Promise<SavedSummary> {
  const body = text.slice(0, SUMMARY_CHARS);
  const row = await query<NoteRow>(
    `INSERT INTO workspace_notes (id, user_id, workspace_id, kind, body, url, meta, dedupe_key)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'summary', $4, NULL, $5::jsonb, 'current')
     ON CONFLICT (user_id, workspace_id, kind, dedupe_key)
     DO UPDATE SET body = EXCLUDED.body, meta = EXCLUDED.meta, updated_at = now()
     RETURNING id, body, url, meta, created_at, updated_at`,
    [randomUUID(), userId, workspaceId, body, JSON.stringify(meta)],
  );
  const saved = row.rows[0];
  return mapSummary(saved);
}

function mapSummary(row: NoteRow): SavedSummary {
  const meta = row.meta ?? {};
  const coverage = (meta.coverage as SummaryCoverage | undefined) ?? { tabsTotal: 0, tabsIncluded: 0, pagesRead: 0 };
  return {
    text: row.body,
    updatedAt: iso(row.updated_at),
    coverage,
    unreadable: typeof meta.unreadable === "number" ? meta.unreadable : 0,
  };
}

export async function listSummary(userId: string, workspaceId: string): Promise<SavedSummary | null> {
  const result = await query<NoteRow>(
    `SELECT id, body, url, meta, created_at, updated_at FROM workspace_notes
     WHERE user_id = $1::uuid AND workspace_id = $2::uuid AND kind = 'summary' AND dedupe_key = 'current'
     LIMIT 1`,
    [userId, workspaceId],
  );
  return result.rows[0] ? mapSummary(result.rows[0]) : null;
}

async function addKind(
  userId: string,
  workspaceId: string,
  kind: "query" | "ref",
  items: { body: string; url?: string | null }[],
  cap: number,
): Promise<SaveCount> {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [`notes:${kind}:${userId}:${workspaceId}`]);
    const counted = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM workspace_notes
       WHERE user_id = $1::uuid AND workspace_id = $2::uuid AND kind = $3`,
      [userId, workspaceId, kind],
    );
    let remaining = cap - Number(counted.rows[0].n);
    let added = 0;
    let skippedDuplicates = 0;
    let refused = 0;
    for (const item of items) {
      if (remaining <= 0) {
        refused += 1;
        continue;
      }
      const key = dedupeKey(kind, item.body, item.url);
      const inserted = await client.query(
        `INSERT INTO workspace_notes (id, user_id, workspace_id, kind, body, url, meta, dedupe_key)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, '{}'::jsonb, $7)
         ON CONFLICT (user_id, workspace_id, kind, dedupe_key) DO NOTHING
         RETURNING id`,
        [randomUUID(), userId, workspaceId, kind, item.body, item.url ?? null, key],
      );
      if ((inserted.rowCount ?? 0) > 0) {
        added += 1;
        remaining -= 1;
      } else {
        skippedDuplicates += 1;
      }
    }
    return { added, skippedDuplicates, refused };
  });
}

export async function addQueries(userId: string, workspaceId: string, queries: string[]): Promise<SaveCount> {
  return addKind(
    userId,
    workspaceId,
    "query",
    queries.map((body) => ({ body })),
    SAVED_QUERIES_MAX,
  );
}

export async function listQueries(userId: string, workspaceId: string): Promise<string[]> {
  const result = await query<{ body: string }>(
    `SELECT body FROM workspace_notes
     WHERE user_id = $1::uuid AND workspace_id = $2::uuid AND kind = 'query'
     ORDER BY created_at ASC, id ASC
     LIMIT $3`,
    [userId, workspaceId, SAVED_QUERIES_MAX],
  );
  return result.rows.map((row) => row.body);
}

export async function addRefs(
  userId: string,
  workspaceId: string,
  refs: { quote: string; url: string }[],
): Promise<SaveCount> {
  return addKind(
    userId,
    workspaceId,
    "ref",
    refs.map((ref) => ({ body: ref.quote, url: ref.url })),
    SAVED_REFS_MAX,
  );
}

export async function countRefs(userId: string, workspaceId: string): Promise<number> {
  const result = await query<{ n: string }>(
    `SELECT count(*) AS n FROM workspace_notes
     WHERE user_id = $1::uuid AND workspace_id = $2::uuid AND kind = 'ref'`,
    [userId, workspaceId],
  );
  return Number(result.rows[0].n);
}

export async function listRefs(userId: string, workspaceId: string): Promise<{ quote: string; url: string }[]> {
  const result = await query<{ body: string; url: string | null }>(
    `SELECT body, url FROM workspace_notes
     WHERE user_id = $1::uuid AND workspace_id = $2::uuid AND kind = 'ref'
     ORDER BY created_at ASC, id ASC
     LIMIT $3`,
    [userId, workspaceId, SAVED_REFS_MAX],
  );
  return result.rows.map((row) => ({ quote: row.body, url: row.url ?? "" }));
}
