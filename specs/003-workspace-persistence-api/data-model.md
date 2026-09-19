# Data Model: Workspace Persistence API

Canonical types: `@ai-browser/shared` (`packages/shared/src/domain.ts`).
Physical tables: `packages/shared/sql/001_init.sql` (feature 001). This feature **does not** add tables except using `users`, `workspaces`, `tab_refs`, `tab_events`.

## Entities used

### User

| Field | Persistence |
| --- | --- |
| `id` | UUID, generated on first successful pair |
| `deviceTokenHash` | SHA-256/HMAC of pairing token; unique |
| `createdAt` | default now() |

No session table. The bearer token *is* the session.

### Workspace

| Field | Rules |
| --- | --- |
| `id` | UUID, server-generated |
| `userId` | from auth; never from client body |
| `name` | 1–80 chars, required on create |
| `emoji` | optional |
| `status` | `active` (default) \| `archived` (and `saved` allowed in DB but unused in 003) |
| `createdAt` / `updatedAt` | server-set; bump `updatedAt` on PATCH |

**Transitions**: `active` → `archived` → `active`. List default: `status <> 'archived'`.

### TabRef

| Field | Rules |
| --- | --- |
| `workspaceId` | UUID or **null (Other)** |
| `chromeTabId` | optional int; used for upsert + resolve |
| `url` / `title` / `snippet` | snippet cap ~2000 |
| `userId` | from auth; must match workspace’s user if workspace set |

**Move**: PATCH `workspaceId` only; at most one workspace.

### TabEvent

Append-only insert. `eventType` one of `opened` \| `updated` \| `activated` \| `closed` \| `reassigned`. `workspaceId` snapshot may be null. Do not update/delete events in 003.

## Pairing

Not an entity in SQL. Algorithm:

1. Client holds `deviceToken` (opaque string, ≥128 bits entropy recommended).
2. `hash = hex(sha256(DEVICE_TOKEN_SECRET + ":" + deviceToken))`
3. `SELECT id FROM users WHERE device_token_hash = hash`
4. If missing, `INSERT INTO users (id, device_token_hash) VALUES (gen_random_uuid(), hash)`

## Integrity (already in 001 SQL)

- Child `user_id` matches workspace via composite FKs.
- `tab_refs.workspace_id` NULL = Other.
- Workspace delete would SET NULL on tab_refs; 003 does not delete workspaces.

## Out of scope tables

`plan_items`, `messages`, `action_runs`, `corrections` — do not expose routes in 003.
