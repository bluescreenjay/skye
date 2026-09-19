# Contract: `@ai-browser/shared`

The shared package is the **only** canonical TypeScript definition of the domain.
`apps/extension` and `apps/web` MUST import from `@ai-browser/shared` and MUST NOT redeclare these types.

## Package

- Name: `@ai-browser/shared`
- Entry: `src/index.ts` re-exports `src/domain.ts`

## Required exports

```ts
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
  createdAt: string; // ISO-8601
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
  workspaceId: string | null;
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
  fromWorkspaceId: string | null;
  toWorkspaceId: string | null;
  tabRefId: string | null;
  url: string;
  createdAt: string;
}
```

## Compatibility

- Field names: camelCase in TS; snake_case in SQL (`userId` ↔ `user_id`).
- No HTTP API in this feature. Feature 003 will map these types onto routes.
- SQL contract: [001_init.sql](./001_init.sql)
- Env contract: [env.md](./env.md)
