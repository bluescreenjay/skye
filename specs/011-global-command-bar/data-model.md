# Data Model: Global Command Bar

The bar keeps **one new table** (`command_undo`, one row per person) and otherwise reads and writes records that already exist. Everything else in the spec's Key Entities (Command, Interpreted intent, Restructuring change, Find result, Activity recall) is transient: it lives in a request or a reply and is not stored (FR-030).

## Existing records used

| Record | Feature | How the bar uses it |
| --- | --- | --- |
| `workspaces` | 001 | Read (matching, listing); `create`, `rename` write `name`, `status`, `updated_at`; never deleted or archived by a command (Undo of its own create archives, section "Undo" below) |
| `tab_refs` | 001, 004 | Read for the model material, `find`, and current-workspace resolution; `group`/`move`/`merge`/`create` write `workspace_id` and `placement_source = 'user'` |
| `tab_events` | 001 | Read by `recall` (`opened`, `activated`); written as `reassigned` by moves and undo, like organize |
| `corrections` | 001, 004 | A row when a change moves an AI-placed tab, exactly as `PATCH /api/tab-refs/:id` does |
| `cluster_runs`, `cluster_run_moves` | 004 | `organize` runs `runClustering`; its undo is `undoRun` |
| `action_runs`, `plan_items`, `messages` | 010, 008 | Not touched by the bar. An agent press is the 010 route; merge leaves chat, plan items, and runs exactly as they are |

## New record: `command_undo` (`packages/shared/sql/011_command.sql`)

One row per person: the single most recent change made through the bar.

| Column | Type | Meaning |
| --- | --- | --- |
| `user_id` | `UUID` primary key, `REFERENCES users (id) ON DELETE CASCADE` | One row per person, so "only the most recent change" is a table constraint, not a rule in code |
| `kind` | `TEXT`, one of `organize`, `group`, `move`, `rename`, `merge`, `create` | What Undo will reverse |
| `summary` | `TEXT NOT NULL` | The fixed sentence Undo shows ("moved 3 tabs into Kyoto trip"): counts and workspace names only, never tab titles or addresses |
| `payload` | `JSONB NOT NULL` | Ids and prior state Undo needs (below). No titles, addresses, or text the person typed |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | Starts the 10-minute window |

```sql
CREATE TABLE IF NOT EXISTS command_undo (
  user_id UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('organize', 'group', 'move', 'rename', 'merge', 'create')),
  summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 200),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

No other index is needed (the primary key is the only lookup). Recall reads `tab_events` through the existing `tab_events_user_time_idx (user_id, time DESC)`. The migration is idempotent and adds nothing else. It does not touch existing rows.

### `payload` shapes (version 1)

```ts
type UndoPayload =
  | { v: 1; runId: string }                                   // organize (cluster run)
  | { v: 1;                                                   // group, move, merge, create
      moves: { tabRefId: string; fromWorkspaceId: string | null;
               fromSource: "ai" | "user" | null; toWorkspaceId: string | null }[];
      createdWorkspaceId?: string }
  | { v: 1; rename: { workspaceId: string; from: string; to: string } };
```

A `move`, `group`, `merge`, or `create` never has a `runId`; the two shapes are never mixed. `moves` is capped at 200 entries (the executor refuses a larger set before writing anything).

### State transitions

```text
(no row) ── a changing command succeeds ──► present (replaces any earlier row)
present ── Undo succeeds ─────────────────► (no row)
present ── another changing command ───────► present (replaced; the earlier change can no longer be undone)
present ── age > 10 minutes ──────────────► treated as absent; the row is deleted the next time this person reads or writes it
present ── a command that changes nothing ► present, unchanged (no change was made)
```

"Changing" means at least one tab moved, one workspace created, or one name changed. A command that finds nothing to do (nothing to organize, tabs already there) leaves the row alone.

## Undo rules, exactly (spec FR-019, SC-007)

Run inside one transaction that first takes the row `FOR UPDATE` and the person's advisory lock, and returns `{ reverted, kept, note }` counts for the message.

| Kind | Reverts | Never touches |
| --- | --- | --- |
| `organize` | `undoRun(userId, runId)` (feature 004, unchanged) | tabs the person moved since; workspaces they renamed or filled |
| `group`, `move`, `merge`, `create` (moves) | each `moves[i]` where the tab is **still** at `toWorkspaceId` (`IS NOT DISTINCT FROM`) **and** `placement_source = 'user'`: sets `workspace_id = fromWorkspaceId`, `placement_source = fromSource`; writes a `reassigned` event | a tab that is anywhere else now, or no longer `user`-placed (counted as kept where the person put it) |
| `create` / `group` into a new workspace | after the moves, archives `createdWorkspaceId` **only if** `status = 'active'`, it now has no tabs, and `updated_at = created_at` | a workspace the person renamed, touched, or filled |
| `rename` | sets `name = from` **only if** the current name equals `to` and no other non-archived workspace of the person has `from` (case-folded) | a workspace renamed again since; a taken name |
| any | deletes the `command_undo` row | |

If the row is absent or older than 10 minutes, Undo answers "There is nothing to undo." and changes nothing (User Story 6 scenario 9). Undo itself is not undoable.

## In-flight shapes (not stored)

The wire types are in [contracts/shared-command-types.md](./contracts/shared-command-types.md). Their meaning:

### `CommandContext` (what the client says about where the person is)

| Field | Home | A web page |
| --- | --- | --- |
| `surface` | `"home"` | `"page"` |
| `timeZone` | IANA name from `Intl.DateTimeFormat().resolvedOptions().timeZone` | same |
| `expandedWorkspaceIds` | ids of expanded cards (Home has at most one) | `[]` |
| `activeTab` | `null` | `{ chromeTabId, url }` of the active tab |
| `windowTabIds` | `[]` | Chrome tab ids open in this window |

**Resolving "this workspace" (FR-008):** on `page`, the workspace of the active tab's record (by `chromeTabId`, else by address, as `/api/resolve` does); on `home`, the single expanded workspace. None, more than one, or a tab in Other gives a plain question and nothing runs.

**Resolving "these tabs":** for `create`, on `home` the live tabs in Other (`workspace_id IS NULL AND chrome_tab_id IS NOT NULL`); on `page` those of `windowTabIds` with `workspace_id IS NULL`. For `move`, the tabs of the current workspace. "This tab" is the active tab (`page` only). Only `http`/`https` addresses.

### Interpretation (server-internal)

The validated model answer (`contracts/model.md`): a closed `intent`, `confidence`, workspace and tab **short ids already mapped to real ids** (unknown ones dropped), `name`, `period`, `agent`, and the doubt fields. Validation rules:

- `intent` must be in the enum; anything else is `unsupported`.
- `confidence` outside 0 to 1 or missing is 0 (so it becomes a question).
- A tab or workspace id the server did not put in the material is dropped, never guessed.
- `name` passes the clustering name rule (1 to 80 characters, not a generic label like "Group 3", not `Other`, trimmed).
- `parts` are kept only when each is a case-insensitive substring of the typed command and at most 120 characters, at most 3.
- `period.kind` must be in the vocabulary; `date` must be a real calendar date.

### `CommandAction` (a resolved, executable step)

`organize`, `cleanup`, `group { tabRefIds, target }`, `move { tabRefIds, toWorkspaceId }`, `rename { workspaceId, name }`, `merge { fromWorkspaceId, intoWorkspaceId }`, `create { name, tabRefIds }`, `agent { workspaceId, agentId }`, `undo`. Ids inside it are real and are **re-validated on apply** against the current state (ownership, still exists, not archived); a change since typing gives a plain message, not an error. The client never invents one: every action comes out of a `CommandReply`.

### `ChangePreview` (returned by `apply` when confirmation is needed)

`{ title: string, lines: { tabRefId: string | null, title: string, from: string, to: string }[], hiddenCount: number }`. At most 20 lines; `hiddenCount` is the rest. `from`/`to` are workspace names or "Other". For a rename, one line with the two names; for a merge, one line per workspace plus the tab count in `title`. Only strings from the database.

### `RecalledWorkspace`

`{ workspaceId: string | null, name: string, linkable: boolean, visits: number, tabs: { title: string, url: string, visits: number }[] }`, ordered by `visits` descending, at most 5, each with at most 3 tabs. `workspaceId: null` is Other.

### `FoundTab` / `FoundWorkspace`

`FoundTab = { tab: TabRef, workspaceName: string }` (`"Other"` for none). `FoundWorkspace = { workspace: Workspace, tabCount: number }`. At most 8 tabs and at most 5 workspaces per reply, best first, plus `more` (tabs the model ranked beyond the 8).

## Limits (`apps/web/src/command/limits.ts`)

| Name | Value | Where it applies |
| --- | --- | --- |
| `MAX_TEXT_CHARS` | 300 | The client cuts at this with a visible note (FR-027); the server refuses a longer text with 400 `text_too_long` and never trims silently |
| `MAX_TABS_IN_PROMPT` | 150 | Tabs in the model material |
| `MAX_WORKSPACES_IN_PROMPT` | 40 | Workspaces in the model material |
| `TITLE_CHARS`, `URL_CHARS`, `EXCERPT_CHARS` | 100 each | Per tab in the model material |
| `MODEL_DEADLINE_MS`, `MODEL_MAX_TOKENS` | 20,000, 900 | The one request |
| `CONFIDENCE_BAR` | 0.6 | Below it the answer is a question, not an action |
| `UNDO_WINDOW_MINUTES` | 10 | `command_undo` lifetime |
| `MAX_MOVES_PER_CHANGE` | 200 | Executor refuses more, before writing |
| `MAX_PREVIEW_LINES` | 20 | `ChangePreview.lines` |
| `MAX_FOUND_TABS`, `MAX_FOUND_WORKSPACES`, `MODEL_FOUND_TABS` | 8, 5, 12 | Find |
| `MAX_RECALLED_WORKSPACES`, `MAX_RECALLED_TABS` | 5, 3 | Recall |

Client (`apps/extension/src/ui/command.ts`): `COMMAND_MAX_CHARS = 300`, `AGENT_WAIT_MS = 90_000`, `SIGNAL_FRESH_MS = 3_000`.

## Volume and scale

One row per person in `command_undo`; a few hundred bytes of JSON at most (200 moves × about 130 bytes ≈ 26 KB worst case). No growth over time. No new rows in any other table beyond what a move already writes (one `reassigned` event and at most one correction per tab).

## Entities from the spec, mapped

| Spec entity | Realized as |
| --- | --- |
| Command | The `text` of `POST /api/command`; never stored |
| Interpreted intent | The validated interpretation; returned only as the fixed "understood" sentence and a `CommandAction` |
| Command outcome | The reply to `apply`: a summary sentence, counts, and (when there is one) the current `UndoState` read from `command_undo` |
| Restructuring change | A `move`/`group`/`rename`/`merge`/`create` action and its `ChangePreview` |
| Find result | `found` reply |
| Activity recall | `recalled` reply |
| Existing records reused | the table above |
