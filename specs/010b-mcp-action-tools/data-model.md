# Data Model: Action Tools (MCP and Local)

Feature 010b adds **one table** (`workspace_notes`) and **no column** to an existing table. Tool runs reuse `action_runs` (feature 001, used by 010). Everything else is in code or in memory. Migration: `packages/shared/sql/010b_actions.sql` (idempotent, applied with the existing `apply-sql.mjs`). Shared response types go in a new `packages/shared/src/actions.ts` ([contracts/shared-types.md](./contracts/shared-types.md)).

## New table: `workspace_notes`

The workspace's **saved summary**, **saved search queries**, and **saved references**: durable, workspace-owned material that chat and agents read (spec key entities "Saved summary" and "Saved queries and references"; Constitution I "notes, generated content").

```sql
CREATE TABLE IF NOT EXISTS workspace_notes (
  id           UUID PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('summary', 'query', 'ref')),
  -- summary: the text (1 to 3,000). query: the query (3 to 120). ref: the quote (10 to 300).
  body         TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 3000),
  -- ref only: the tab's plain address (no query string or fragment). NULL otherwise.
  url          TEXT,
  -- summary only: { coverage: {tabsTotal, tabsIncluded, pagesRead}, cited: [{title,url}], unreadable: number }.
  meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- summary: 'current' (one row per workspace, replaced on each write).
  -- query / ref: a normalized key (lowercase, collapsed whitespace, folded quote characters; refs add the address).
  dedupe_key   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspaces (id, user_id) ON DELETE CASCADE,
  UNIQUE (user_id, workspace_id, kind, dedupe_key)
);

CREATE INDEX IF NOT EXISTS workspace_notes_workspace_kind_idx
  ON workspace_notes (user_id, workspace_id, kind, created_at, id);
```

Rules:

- **One summary per workspace**: `INSERT … ON CONFLICT (user_id, workspace_id, kind, dedupe_key) DO UPDATE` with `dedupe_key = 'current'`; `updated_at` moves, so "summary version" (used by the suggestion fingerprint and by export) is `updated_at`.
- **Queries and references cap** (10 and 20 per workspace, research 13) is enforced in code inside one transaction under an advisory lock per `(user, workspace, kind)`, like the run guard, so two saves at once cannot pass the cap together. Over the cap, the oldest are **not** deleted: extra items are refused and counted (`refused` in the result), because silently dropping saved material would violate "keep".
- **Duplicates** hit the unique constraint (`ON CONFLICT DO NOTHING`) and are counted as `skippedDuplicates`.
- **Deleting a workspace deletes its notes** (`ON DELETE CASCADE`); nothing external is deleted by the product (spec edge case).
- A ref's `body` must have passed quote verification against its tab's material before insert (research 11). The table stores no page text.
- No mail content, no credentials, and no outside-service content are ever stored here (FR-036, FR-041). Only what the person's own workspace material and their own action produced.

## Existing records used

### `action_runs` (feature 001; used by 010) = one click of one tool

| Column | Use here |
| --- | --- |
| `id` | Run id (UUID). |
| `user_id`, `workspace_id` | Owner and workspace (composite foreign key; deleting the workspace deletes its runs). |
| `action_id` | The **tool id** (`github_create_issue`, `open_related_tabs`, …). Agent ids (`summarize`, …) are a different set; 010 reads filter by them (research 15). |
| `input` (JSONB) | **A summary only**: `{ label, mode: "direct"\|"composed", lockedArgs: string[] (names only), suggestionKey }`. No argument values, no tab text. |
| `output` (JSONB) | See below. `null` until the run finishes, except while it waits for the browser (`awaiting`). |
| `status` | `pending` (shown `running`), `succeeded`, or `failed`. |
| `created_at` | Start time; ordering and the 120 s stale rule use it. |

**`output` while waiting for the browser** (status still `pending`):

```json
{ "awaiting": { "intents": [ { "id": "i1", "kind": "open_tabs", "urls": ["https://…"], "placeInWorkspace": true } ] } }
```

**`output` on success**:

```json
{
  "result": { "kind": "opened", "opened": 4, "skipped": [ { "url": "http://x", "reason": "not_secure" } ], "failed": 0, "placed": 4 },
  "links": [ { "label": "GitHub issue #42", "url": "https://github.com/o/r/issues/42", "id": "42" } ],
  "steps": [ { "kind": "helper", "tool": "github_search", "note": "3 results" }, { "kind": "action", "tool": "github_create_issue", "note": "created" } ],
  "refused": [ { "tool": "slack_post_message", "why": "not_allowed" } ],
  "stoppedAtLimit": false
}
```

**`output` on failure**: `{ "error": { "code": "…", "message": "…", "partial": "…" | null } }` (`partial` is a short plain note of what helpers found before a limit; never page, mail, or service text beyond counts and titles the person's own tabs already have).

- `links` are external results (FR-016). `id` is what later runs may target (Notion page to append to, Drive file to share); a Notion or Drive tool validates its target against `links[].id` of an earlier successful run in the same workspace (research 6).
- `steps` records tool names and short fixed notes only (`"3 results"`, `"created"`), never argument values or service responses.
- `refused` records the tool ids a model step asked for and was refused (spec User Story 2 scenario 6).
- **Email**: a `gmail_send_message` click stores `result.kind = "email_preview"` with `to` (nullable), `subject`, `body`, `expiresAt`, `state` (`unsent`, `sending`, `sent`, `cancelled`, `expired`). The subject and body are workspace-derived material (never mail content). Confirming creates a **second** row (`action_id = gmail_send_message`, `input.previewRunId`) holding the send result.
- **Mail search** stores `result = { "kind": "mail_search", "shown": 3 }` and nothing else (research 9).

`action_runs` gets **no new column and no new index**: 010's indexes already serve these reads (`(user_id, workspace_id, action_id, created_at DESC, id DESC)`) and the "one at a time" guard (`WHERE status = 'pending'`, per tool id, which is exactly the spec's "same action twice is refused").

### `plan_items` (feature 001)

`append_plan_items` inserts after existing rows (`sort_order` continues), skipping case-insensitive duplicates, never touching `done` items, total capped at 30 (010's `MAX_PLAN_ITEMS`).

### `tab_refs`, `messages`, `workspaces`

Read only, by `user_id` and workspace id, exactly as in 010 (`agents/context.ts`). Tools never write `tab_refs`; placing an opened tab into a workspace goes through feature 007's existing move call from the extension.

## In-memory state (not stored)

| State | Where | Notes |
| --- | --- | --- |
| Suggestion set | `globalThis` map keyed `user:workspace` | `{ suggestions, generatedAt, fingerprint }`, replaced on each pass; lost on restart (that only costs one new pass). |
| In-flight pass | same map | The pending promise; a second call joins it. |
| Integration health | `globalThis` map keyed by integration | `rejected` until a timestamp (5 minutes). |
| MCP client sessions | `globalThis` map keyed by integration | Lazily connected, reconnect on failure, closed on process end. Holds transports; never logged. |
| Google access token | `globalThis` | Cached until 60 s before expiry. |
| Tool-loop scratch | run-local | Helper results for that run only; discarded when the run ends. |

## The tool registry (in code, not stored)

Each tool: `id`, `label` (default), `description` (one line, given to the suggestion pass), `integration` (`github`, `jira`, `notion`, `slack`, `drive`, `gmail`, or `null` for local), `effect` (`read`, `write`, `send`), `helper` (true only for the five read-only helpers), `ownerOnly`, `inputSchema` (JSON Schema plus per-argument flags `prefillOnly`, `target`), `execute`, and `preconditions` (for example, "a saved summary exists"). Full table: [contracts/tools.md](./contracts/tools.md).

## Entities from the spec, mapped

| Spec entity | Stored as |
| --- | --- |
| Tool | Registry entry in code; not stored. |
| Integration | Environment configuration plus in-memory health; not stored. |
| Owner | `INTEGRATION_OWNER_USER_ID` (environment); not a database role. |
| Suggestion | In-memory set; not a run. |
| Action run | `action_runs` row (`action_id` = tool id). |
| Browser intent | Inside `action_runs.output` (`awaiting.intents` while pending, `result` on finish). |
| Saved summary | `workspace_notes` row, `kind = 'summary'`. |
| Saved queries and references | `workspace_notes` rows, `kind = 'query'` / `'ref'`. |
| Credential | Environment only; never stored, logged, or returned. |

## State transitions of a tool run

```text
                 click (validate, guard, insert)
[none] ─────────────────────────────────────────▶ pending ──tool ok, no browser step──▶ succeeded
                                                    │  │
                                                    │  ├──tool ok, browser step──▶ pending(awaiting) ──extension reports──▶ succeeded | failed
                                                    │  ├──error / limit / refused-only / AI failure──▶ failed
                                                    │  └──older than 120 s when anyone reads or clicks──▶ failed (timed_out)
                                                    └── (mail search only) runs inside the click request and finishes before the response
```

`gmail_send_message` adds a second, separate track on the **preview** result (`unsent → sending → sent`, or `cancelled`, or `expired`) that is never a run state.

## Volume and scale

At most 10 (plus one preserved) runs per tool per workspace, about 30 tools, so up to about 330 rows per workspace in the worst case, each a few kilobytes; in practice a handful of tools are ever used. `workspace_notes` is at most 1 + 10 + 20 rows per workspace. Reads are by `(user_id, workspace_id)` and hit existing indexes plus the one above.
