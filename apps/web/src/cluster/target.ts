// Where does a group go? One rule, used both when a run applies a group and when a
// user accepts a suggestion (FR-006, FR-007, FR-008):
//   1. the existing active workspace the model named (by id), if it is still active;
//   2. else an existing active workspace with the same name (trimmed, any case);
//   3. else nothing: the caller creates a new one.
// An archived workspace is never a target, and no group may be named "Other".
import type { QueryResult, QueryResultRow } from "pg";
import type { DbWorkspace } from "../map";

const WORKSPACE_COLUMNS = "id, user_id, name, emoji, status, created_at, updated_at";

type Db = { query: <T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) => Promise<QueryResult<T>> };

/** "Other" is the reserved bucket for tabs without a workspace; no workspace may stand in for it. */
export function isReservedName(name: string): boolean {
  return name.trim().toLowerCase() === "other";
}

/**
 * The existing, non-archived workspace this group belongs in, or null if it needs a new
 * one. Read against the database each time (inside the caller's transaction), so a
 * workspace archived or created since the model was asked is honored.
 */
export async function findExistingWorkspace(
  db: Db,
  userId: string,
  group: { name: string; existingWorkspaceId: string | null },
): Promise<DbWorkspace | null> {
  if (group.existingWorkspaceId) {
    const byId = await db.query<DbWorkspace>(
      `SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = $1 AND user_id = $2 AND status <> 'archived'`,
      [group.existingWorkspaceId, userId],
    );
    if (byId.rows[0]) return byId.rows[0];
  }
  const byName = await db.query<DbWorkspace>(
    `SELECT ${WORKSPACE_COLUMNS} FROM workspaces
     WHERE user_id = $1 AND status <> 'archived' AND lower(btrim(name)) = lower(btrim($2))
     ORDER BY created_at, id LIMIT 1`,
    [userId, group.name],
  );
  return byName.rows[0] ?? null;
}
