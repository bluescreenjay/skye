# Data Model: Shared Domain Model

Canonical TypeScript names live in `packages/shared`. SQL names are snake_case. All timestamps are UTC ISO-8601 in types / `timestamptz` in SQL.

## Enums / unions

| Name | Values |
| --- | --- |
| `WorkspaceStatus` | `active` \| `saved` \| `archived` |
| `TabEventType` | `opened` \| `updated` \| `activated` \| `closed` \| `reassigned` |
| `MessageRole` | `user` \| `assistant` \| `system` |
| `ActionRunStatus` | `pending` \| `succeeded` \| `failed` |

## Entities

### User

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID string | PK |
| `deviceTokenHash` | string | Unique; hash of pairing token, never store raw token |
| `createdAt` | datetime | Required |

**Relationships**: owns workspaces, tab refs, tab events, corrections (via `user_id` on children).

### Workspace

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID string | PK |
| `userId` | UUID string | FK User, required |
| `name` | string | 1–80 chars |
| `emoji` | string \| null | Optional, short |
| `status` | WorkspaceStatus | Default `active` |
| `createdAt` | datetime | Required |
| `updatedAt` | datetime | Required |

**Relationships**: has many TabRefs, PlanItems, Messages, ActionRuns. Survives with zero TabRefs.

**State**: `active` → `saved` → `archived` (and back to `active` when reopened). This feature does not implement transitions; it only types them.

### TabRef

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID string | PK |
| `userId` | UUID string | FK User, required |
| `workspaceId` | UUID string \| null | FK Workspace; **null = Other** |
| `url` | string | Required, max ~2048 |
| `title` | string | May be empty |
| `snippet` | string | Short excerpt; cap ~2000 chars; not full HTML |
| `chromeTabId` | number \| null | Live browser id; ephemeral |
| `lastSeenAt` | datetime | Required |

**Validation**: If `workspaceId` is set, that workspace’s `userId` MUST match `tab_refs.user_id`.

### TabEvent

| Field | Type | Rules |
| --- | --- | --- |
| `time` | datetime | Part of identity; hypertable dimension |
| `id` | UUID string | Unique event id |
| `userId` | UUID string | Required |
| `tabRefId` | UUID string \| null | Optional link to TabRef |
| `chromeTabId` | number \| null | |
| `url` | string | |
| `title` | string | |
| `workspaceId` | UUID string \| null | Membership at event time; null = Other |
| `eventType` | TabEventType | Required |

**Validation**: Append-only. No updates in later features except via new events.

**Tiger**: `SELECT create_hypertable('tab_events', 'time', if_not_exists => TRUE);`  
**Pivot**: skip hypertable; index `(user_id, time DESC)`.

### PlanItem

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID string | PK |
| `userId` | UUID string | Required (denormalized for RLS) |
| `workspaceId` | UUID string | FK Workspace, required |
| `text` | string | Required |
| `done` | boolean | Default false |
| `sortOrder` | number | Integer |

Defined now; populated in feature 009.

### Message

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID string | PK |
| `userId` | UUID string | Required |
| `workspaceId` | UUID string | Required |
| `role` | MessageRole | Required |
| `content` | string | Required |
| `createdAt` | datetime | Required |

Defined now; populated in feature 008.

### ActionRun

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID string | PK |
| `userId` | UUID string | Required |
| `workspaceId` | UUID string | Required |
| `actionId` | string | Stable slug, e.g. `summarize` |
| `input` | JSON object | |
| `output` | JSON object \| null | |
| `status` | ActionRunStatus | Default `pending` |
| `createdAt` | datetime | Required |

Defined now; populated in feature 010.

### Correction

| Field | Type | Rules |
| --- | --- | --- |
| `id` | UUID string | PK |
| `userId` | UUID string | Required |
| `fromWorkspaceId` | UUID string \| null | null = was Other |
| `toWorkspaceId` | UUID string \| null | null = moved to Other |
| `tabRefId` | UUID string \| null | |
| `url` | string | Snapshot for learning signals |
| `createdAt` | datetime | Required |

Defined now; populated in feature 007.

## Relationship diagram

```text
User 1──* Workspace 1──* PlanItem
  │            ├──* Message
  │            ├──* ActionRun
  │            └──* TabRef (workspace_id nullable → Other)
  ├──* TabEvent
  └──* Correction
```

## Integrity rules (enforce in SQL)

1. Child `user_id` matches parent workspace `user_id` (trigger or composite FK).
2. No durable row without `user_id`.
3. Deleting a user cascades (dev convenience) or restricts (prod later); 001 may `ON DELETE CASCADE` for simplicity.
4. Workspace delete: tab_refs set `workspace_id` NULL (become Other) rather than destroying history; events remain.
