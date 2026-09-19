import type { TabEvent, TabRef, User, Workspace } from "@ai-browser/shared";

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export type DbUser = {
  id: string;
  device_token_hash: string;
  created_at: Date | string;
};

export type DbWorkspace = {
  id: string;
  user_id: string;
  name: string;
  emoji: string | null;
  status: Workspace["status"];
  created_at: Date | string;
  updated_at: Date | string;
};

export type DbTabRef = {
  id: string;
  user_id: string;
  workspace_id: string | null;
  url: string;
  title: string;
  snippet: string;
  chrome_tab_id: number | null;
  last_seen_at: Date | string;
};

export type DbTabEvent = {
  time: Date | string;
  id: string;
  user_id: string;
  tab_ref_id: string | null;
  chrome_tab_id: number | null;
  url: string;
  title: string;
  workspace_id: string | null;
  event_type: TabEvent["eventType"];
};

export function mapUser(row: DbUser): User {
  return {
    id: row.id,
    deviceTokenHash: row.device_token_hash,
    createdAt: iso(row.created_at),
  };
}

export function mapWorkspace(row: DbWorkspace): Workspace {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    emoji: row.emoji,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function mapTabRef(row: DbTabRef): TabRef {
  return {
    id: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    url: row.url,
    title: row.title,
    snippet: row.snippet,
    chromeTabId: row.chrome_tab_id,
    lastSeenAt: iso(row.last_seen_at),
  };
}

export function mapTabEvent(row: DbTabEvent): TabEvent {
  return {
    time: iso(row.time),
    id: row.id,
    userId: row.user_id,
    tabRefId: row.tab_ref_id,
    chromeTabId: row.chrome_tab_id,
    url: row.url,
    title: row.title,
    workspaceId: row.workspace_id,
    eventType: row.event_type,
  };
}
