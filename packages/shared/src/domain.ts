// Canonical domain model for AI Browser. The extension and web app import
// these types from `@ai-browser/shared`; they MUST NOT redeclare them.
// Field names are camelCase here and snake_case in SQL (userId <-> user_id).
// IDs are UUID strings; timestamps are UTC ISO-8601 strings.

export type WorkspaceStatus = "active" | "saved" | "archived";

export type TabEventType =
  | "opened"
  | "updated"
  | "activated"
  | "closed"
  | "reassigned";

export type MessageRole = "user" | "assistant" | "system";

export type ActionRunStatus = "pending" | "succeeded" | "failed";

export interface User {
  id: string;
  deviceTokenHash: string;
  createdAt: string;
}

export interface Workspace {
  id: string;
  userId: string;
  name: string;
  emoji: string | null;
  status: WorkspaceStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TabRef {
  id: string;
  userId: string;
  workspaceId: string | null; // null = Other
  url: string;
  title: string;
  snippet: string;
  chromeTabId: number | null;
  lastSeenAt: string;
}

export interface TabEvent {
  time: string;
  id: string;
  userId: string;
  tabRefId: string | null;
  chromeTabId: number | null;
  url: string;
  title: string;
  workspaceId: string | null; // membership at event time; null = Other
  eventType: TabEventType;
}

export interface PlanItem {
  id: string;
  userId: string;
  workspaceId: string;
  text: string;
  done: boolean;
  sortOrder: number;
}

export interface Message {
  id: string;
  userId: string;
  workspaceId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface ActionRun {
  id: string;
  userId: string;
  workspaceId: string;
  actionId: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  status: ActionRunStatus;
  createdAt: string;
}

export interface Correction {
  id: string;
  userId: string;
  fromWorkspaceId: string | null; // null = was Other
  toWorkspaceId: string | null; // null = moved to Other
  tabRefId: string | null;
  url: string;
  createdAt: string;
}
