import type {
  ClusterRun,
  Message,
  PlacementSource,
  Suggestion,
  TabEvent,
  TabRef,
  User,
  Workspace,
} from "@ai-browser/shared";

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
  placement_source: PlacementSource | null;
};

/** The tab_refs columns that map to a TabRef. Use it in every SELECT/RETURNING that feeds mapTabRef. */
export const TAB_REF_COLUMNS =
  "id, user_id, workspace_id, url, title, snippet, chrome_tab_id, last_seen_at, placement_source";

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

export type DbMessage = {
  id: string;
  user_id: string;
  workspace_id: string;
  role: Message["role"];
  content: string;
  created_at: Date | string;
};

/** The messages columns that map to a Message. Use it in every SELECT/RETURNING that feeds mapMessage. */
export const MESSAGE_COLUMNS = "id, user_id, workspace_id, role, content, created_at";

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
    placementSource: row.placement_source ?? null,
  };
}

export function mapMessage(row: DbMessage): Message {
  return {
    id: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    role: row.role,
    content: row.content,
    createdAt: iso(row.created_at),
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

export type DbClusterRun = {
  id: string;
  user_id: string;
  status: ClusterRun["status"];
  started_at: Date | string;
  finished_at: Date | string | null;
  considered_count: number;
  left_out_count: number;
  applied_count: number;
  suggestion_count: number;
  discarded_count: number;
  created_workspace_ids: string[];
  error: string | null;
  undone_at: Date | string | null;
};

/** The cluster_runs columns that map to a ClusterRun (the fingerprints stay server-side). */
export const CLUSTER_RUN_COLUMNS =
  "id, user_id, status, started_at, finished_at, considered_count, left_out_count, applied_count, " +
  "suggestion_count, discarded_count, created_workspace_ids, error, undone_at";

export type DbSuggestion = {
  id: string;
  user_id: string;
  run_id: string;
  name: string;
  emoji: string | null;
  target_workspace_id: string | null;
  confidence: number;
  tab_ref_ids: string[];
  status: Suggestion["status"];
  created_at: Date | string;
  resolved_at: Date | string | null;
};

/** The suggestions columns that map to a Suggestion. */
export const SUGGESTION_COLUMNS =
  "id, user_id, run_id, name, emoji, target_workspace_id, confidence, tab_ref_ids, status, created_at, resolved_at";

export function mapClusterRun(row: DbClusterRun): ClusterRun {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    startedAt: iso(row.started_at),
    finishedAt: row.finished_at ? iso(row.finished_at) : null,
    consideredCount: row.considered_count,
    leftOutCount: row.left_out_count,
    appliedCount: row.applied_count,
    suggestionCount: row.suggestion_count,
    discardedCount: row.discarded_count,
    createdWorkspaceIds: row.created_workspace_ids ?? [],
    error: row.error,
    undoneAt: row.undone_at ? iso(row.undone_at) : null,
  };
}

export function mapSuggestion(row: DbSuggestion): Suggestion {
  return {
    id: row.id,
    userId: row.user_id,
    runId: row.run_id,
    name: row.name,
    emoji: row.emoji,
    targetWorkspaceId: row.target_workspace_id,
    confidence: Number(row.confidence),
    tabRefIds: row.tab_ref_ids ?? [],
    status: row.status,
    createdAt: iso(row.created_at),
    resolvedAt: row.resolved_at ? iso(row.resolved_at) : null,
  };
}
