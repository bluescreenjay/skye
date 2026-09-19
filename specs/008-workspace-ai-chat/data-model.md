# Data Model: Workspace AI Chat

Canonical types: `@ai-browser/shared` (`packages/shared/src/domain.ts` for `Message`, new `packages/shared/src/chat.ts` for the chat response shapes). Physical tables: `packages/shared/sql/001_init.sql`. This feature adds **no table and no column**; it adds one index in a new idempotent migration, `packages/shared/sql/008_chat.sql`.

## Entities used

### Message (existing, unchanged)

| Field | Persistence and rules |
| --- | --- |
| `id` | UUID, server-generated |
| `userId` | from auth, never from the request |
| `workspaceId` | the workspace this conversation belongs to; composite foreign key with `userId` onto `workspaces (id, user_id)` (`ON DELETE CASCADE`), so a message can never point at another user's workspace |
| `role` | `user` or `assistant` here (`system` exists in the schema and is not used) |
| `content` | the text. User messages: 1 to 4,000 characters after trimming. Assistant messages: the complete reply |
| `createdAt` | server time when the row is inserted |

**Nothing marks a message as unfinished, on purpose.** An assistant message is inserted once, after the reply finished normally. A reply that fails, is cut off, or is abandoned leaves no row (research section 4). A user message is inserted before the model is asked.

**Order**: a conversation is a workspace's messages ordered by `(created_at, id)`. `id` only breaks a tie that cannot normally occur (two inserts in the same microsecond).

**Unanswered**: the newest message of a workspace is a `user` message. That is the only condition; no flag is stored.

### Tab reference, Plan item, Workspace (existing, read-only here)

Chat only reads them, always with the user's id and the workspace's id in the query.

| Read | Rule |
| --- | --- |
| Tabs | `tab_refs` of this user and workspace with an `http(s)` address; open tabs first (`chrome_tab_id IS NOT NULL`), then `last_seen_at` newest first; at most 40; plus the total count |
| Plan items | `plan_items` of this user and workspace ordered by `sort_order`; at most 30. The table exists from feature 001 and stays empty until feature 009 |
| Workspace | id, name, status, for the ownership check and the workspace name in the context |

## Derived, not stored: workspace context

Built fresh for every message, held only in memory for the call, never stored and never logged.

| Part | Content |
| --- | --- |
| System message | fixed rules (contracts/model.md) followed by one JSON data block |
| Data block | `workspace` (`name`, `tabsInWorkspace`, `tabsShown`), `tabs` (`title` up to 200, `url` without query and fragment up to 200, `excerpt` up to 400), `plan` (`text` up to 200, `done`) |
| Conversation turns | the last 20 messages, oldest first, `user` and `assistant` only; the oldest are dropped first if the total would exceed 24,000 characters; the message being answered is always the last turn |
| Context info (returned to the caller) | `tabsIncluded`, `tabsTotal`, `planItemsIncluded`, `messagesIncluded` |

## Migration `008_chat.sql`

```sql
CREATE INDEX IF NOT EXISTS messages_user_workspace_created_idx
  ON messages (user_id, workspace_id, created_at DESC, id DESC);
```

Serves both the history page (newest first, then reversed) and the "newest message" check. Safe to run repeatedly. Nothing else changes in the database.

## In-memory state (not persisted)

| State | Where | Rules |
| --- | --- | --- |
| Reply lock | `globalThis`, key `userId:workspaceId` | taken before the user message is saved, released when the reply is saved, fails, or is abandoned; a lock older than 120 s is treated as stale and replaced |
| Concurrency slots and daily budget | the shared AI layer (features 004) | unchanged; chat draws on the `chat` purpose |

## Flows (server side)

**Send** (`POST`):

1. Authenticate; validate the body (`message` 1 to 4,000 characters after trimming, or `retry: true` with no message); the workspace must exist for this user (`other` is refused as not a workspace).
2. Check the model is configured (nothing is saved if it is not).
3. Take the reply lock (`409 reply_in_progress` if held).
4. Insert the user message (skipped for a retry, which uses the newest user message).
5. Build the context (tabs, plan items, recent turns).
6. Start the model stream and wait for the first piece. If this fails, release the lock and answer with the error; the user message stays saved.
7. Deliver pieces to the caller. On normal finish, insert the assistant message once and release the lock. On failure, client disconnect, or the 90 s cap, insert nothing and release the lock.

**Read** (`GET`): user-scoped query of one workspace's messages by `(created_at, id)`, paged backwards with a message-id cursor; no model call and no lock.

## Isolation guarantees

- Every statement that reads or writes messages, tabs, plan items, or workspaces includes `user_id = $currentUser` and the workspace id taken from the path after the ownership check.
- The composite foreign key rejects a message that names a workspace of a different user, even if application code were wrong.
- The model input is built only from those queries; there is no code path that reads another workspace's rows for chat.
