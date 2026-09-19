// Database helpers for workspace chat. Every query filters by the user AND the workspace, so
// no path here can return another user's or another workspace's messages. Chat adds no table:
// it reads and writes the `messages` table from feature 001 (specs/008-workspace-ai-chat/data-model.md).
import { randomUUID } from "crypto";
import type { Message } from "@ai-browser/shared";
import { query } from "../db";
import { MESSAGE_COLUMNS, mapMessage, type DbMessage, type DbWorkspace } from "../map";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The user's workspace, or null. A malformed id is null without asking the database (Postgres would reject it). */
export async function findWorkspace(userId: string, id: string): Promise<DbWorkspace | null> {
  if (!UUID.test(id)) return null;
  const result = await query<DbWorkspace>(
    `SELECT id, user_id, name, emoji, status, created_at, updated_at
     FROM workspaces WHERE id = $1::uuid AND user_id = $2::uuid`,
    [id, userId],
  );
  return result.rows[0] ?? null;
}

export async function insertMessage(userId: string, workspaceId: string, role: Message["role"], content: string): Promise<Message> {
  const result = await query<DbMessage>(
    `INSERT INTO messages (id, user_id, workspace_id, role, content)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
     RETURNING ${MESSAGE_COLUMNS}`,
    [randomUUID(), userId, workspaceId, role, content],
  );
  return mapMessage(result.rows[0]);
}

/** The newest message in this workspace's conversation, or null when there is none. */
export async function newestMessage(userId: string, workspaceId: string): Promise<Message | null> {
  const result = await query<DbMessage>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE user_id = $1::uuid AND workspace_id = $2::uuid
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [userId, workspaceId],
  );
  return result.rows[0] ? mapMessage(result.rows[0]) : null;
}

/**
 * One page of the conversation, oldest first. Without `beforeId` it is the newest page; with it,
 * the page just older than that message. Returns null when `beforeId` is not a message of this
 * workspace (the route answers 400 invalid_cursor). The cursor is compared in SQL, so the
 * database's microsecond timestamps are never rounded through a JavaScript Date.
 */
export async function historyPage(
  userId: string,
  workspaceId: string,
  options: { limit: number; beforeId?: string },
): Promise<{ messages: Message[]; hasMore: boolean } | null> {
  const { limit, beforeId } = options;
  const params: unknown[] = [userId, workspaceId, limit + 1];
  let older = "";
  if (beforeId !== undefined) {
    if (!UUID.test(beforeId)) return null;
    const known = await query(
      "SELECT 1 FROM messages WHERE id = $1::uuid AND user_id = $2::uuid AND workspace_id = $3::uuid",
      [beforeId, userId, workspaceId],
    );
    if (known.rowCount === 0) return null;
    params.push(beforeId);
    older = `AND (created_at, id) < (SELECT created_at, id FROM messages WHERE id = $4::uuid AND user_id = $1::uuid AND workspace_id = $2::uuid)`;
  }
  const result = await query<DbMessage>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE user_id = $1::uuid AND workspace_id = $2::uuid ${older}
     ORDER BY created_at DESC, id DESC LIMIT $3::int`,
    params,
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit).reverse();
  return { messages: rows.map(mapMessage), hasMore };
}

/** The last `limit` user and assistant messages, oldest first: what the model sees of the conversation. */
export async function recentTurns(userId: string, workspaceId: string, limit: number): Promise<Message[]> {
  const result = await query<DbMessage>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE user_id = $1::uuid AND workspace_id = $2::uuid AND role IN ('user', 'assistant')
     ORDER BY created_at DESC, id DESC LIMIT $3::int`,
    [userId, workspaceId, limit],
  );
  return result.rows.reverse().map(mapMessage);
}
