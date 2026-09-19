# Data Model: Workspace Agents

Feature 010 adds **no table and no column**. It stores runs in the existing `action_runs` table and checklists in the existing `plan_items` table, and adds three indexes (`packages/shared/sql/010_agents.sql`). Shared response types go in a new `packages/shared/src/agents.ts`.

## Existing records used

### `action_runs` (feature 001) = one press of one agent

| Column | Use here |
| --- | --- |
| `id` | Run id (UUID). |
| `user_id`, `workspace_id` | Owner and workspace. Composite foreign key to `workspaces (id, user_id)`; deleting the workspace deletes its runs. |
| `action_id` | The agent id: `summarize`, `compare`, `missing`, `next-steps`, or `refs`. |
| `input` (JSONB) | A **summary with counts only** (see below). No tab text, page text, or addresses. |
| `output` (JSONB, null while running) | On success: `{ result, sources, coverage }`. On failure: `{ error: { code, message } }`. |
| `status` | `pending` (shown to clients as `running`), `succeeded`, or `failed`. |
| `created_at` | When the run started. Ordering and staleness use it. |

`input` shape:

```json
{ "tabsTotal": 9, "tabsIncluded": 9, "pagesTried": 8, "chatMessages": 6, "planItems": 3 }
```

### Output on success

```json
{
  "result": { "kind": "text", "text": "…", "cited": [{ "title": "…", "url": "https://…/page" }] },
  "sources": [
    { "title": "Flights to Kyoto", "url": "https://www.google.com/travel/flights", "read": "page",
      "reason": null, "trimmed": true, "truncated": false }
  ],
  "coverage": { "tabsTotal": 9, "tabsIncluded": 9, "pagesRead": 6 }
}
```

- `sources` lists every tab the run used (at most 40), by title and **plain address**; tabs that share a plain address are merged into one entry (the first tab's title), and `coverage` counts entries. `read` is `page` (page text was read) or `excerpt` (only the stored excerpt, title, and address were known). When `read` is `excerpt` because the page could not be read, `reason` is one of the fixed categories below; when the tab was simply beyond the per-run page limit, `reason` is `over_limit`.
- `trimmed` is true when the tab's address had a query string or fragment that was removed to read the page (spec FR-020). `truncated` is true when the page text was cut at the size cap.
- `coverage` is the "read N of M" line (spec FR-024).

### Output on failure

```json
{ "error": { "code": "model_error", "message": "The AI assistant couldn't run this right now. You can run it again." } }
```

Codes and sentences are in [contracts/http.md](./contracts/http.md); the message is always one of a fixed set, never text from the AI service.

### Answer shapes (`result`)

Each agent has one **kind**. The AI's strict JSON answer is validated and normalized into these stored shapes (tab ids `t1..tN` become title and plain address).

| Kind | Agents | Stored shape |
| --- | --- | --- |
| `text` | `summarize`, `missing` | `{ "kind": "text", "text": string (1 to 3000 chars, short paragraphs and "- " lines), "cited": [{ "title", "url" }] }` |
| `comparison` | `compare` | `{ "kind": "comparison", "criteria": string[] (2 to 6), "options": [{ "name": string, "tab": { "title", "url" } \| null, "values": string[] (same length as criteria) }] (1 to 8), "verdict": string (0 to 600) }` |
| `checklist` | `next-steps` | `{ "kind": "checklist", "items": string[] (1 to 8, each 1 to 200 chars) }` |
| `quotes` | `refs` | `{ "kind": "quotes", "quotes": [{ "quote": string (10 to 300 chars), "tab": { "title", "url" } }] (0 to 10), "note": string \| null }` |

Validation rules (server side, in `validate.ts`):

- Unknown tab ids are dropped (a comparison option loses its `tab`; a `cited` entry disappears).
- **Quotes**: a quote is kept only if, after normalizing case, runs of whitespace, curly versus straight quotes, and dash variants, it is a substring of the material given for the tab it cites (page text if read, otherwise excerpt and title). Dropped quotes are counted into `note` ("3 quotes could not be verified and were left out"). Zero surviving quotes is a success with `quotes: []` and a note.
- Checklist items are trimmed, de-duplicated (case-insensitively), and cut to 200 characters; more than 8 are cut to the first 8.
- Empty text, no options, or no checklist items after cleaning is `bad_answer`.

### Fixed reason categories (`sources[].reason`)

`private_address` (not a public internet address, or credentials or an odd port in the address), `not_secure` (a plain `http:` address), `needs_sign_in`, `not_a_web_page` (PDF, image, download), `too_large`, `too_slow`, `no_text` (page has too little readable text), `error`, `over_limit` (beyond the per-run page limit; excerpt only).

## State transitions

```text
                 press (insert, unique guard)
[none] ───────────────────────────────▶ pending ──job ok──▶ succeeded
                                          │  │
                                          │  └──job error / AI failure / 50 s limit──▶ failed
                                          └──older than 120 s when anyone reads or presses──▶ failed (timed_out)
```

- Stale runs are reaped on **every read** of a workspace's agents or runs and on every press (one conditional update), so a run whose server stopped shows as `failed` even if nobody presses anything again (spec FR-011).
- A run in `pending` that is reaped as stale becomes `failed` with `{ error: { code: "timed_out", … } }`. A late job then finds it no longer `pending` and writes nothing.
- `succeeded` and `failed` are final.

## Retention (spec FR-043)

After every finish (either way), in the same request that finished it, delete for that `(user_id, workspace_id, action_id)`:

```sql
DELETE FROM action_runs r
WHERE r.user_id = $1 AND r.workspace_id = $2 AND r.action_id = $3
  AND r.status <> 'pending'
  AND r.id NOT IN (
    SELECT id FROM action_runs
    WHERE user_id = $1 AND workspace_id = $2 AND action_id = $3
    ORDER BY created_at DESC, id DESC LIMIT 10)
  AND r.id IS DISTINCT FROM (
    SELECT id FROM action_runs
    WHERE user_id = $1 AND workspace_id = $2 AND action_id = $3 AND status = 'succeeded'
    ORDER BY created_at DESC, id DESC LIMIT 1);
```

(Parameters are cast, `$1::uuid` and so on, as elsewhere in this codebase.) The newest `succeeded` run is therefore never removed even when the ten newest are all failures, so a workspace may briefly hold 11 runs of one agent.

## `plan_items` (feature 001) = the "next steps" checklist

| Column | Use here |
| --- | --- |
| `id`, `user_id`, `workspace_id` | As usual; composite foreign key to `workspaces`. |
| `text` | The item, 1 to 200 characters. |
| `done` | Ticked or not. |
| `sort_order` | Position; kept items first, then new ones. |

Rules:

- A "next steps" success rewrites the workspace's items **in the same transaction that marks the run `succeeded`** (only if it is still `pending`): keep the ticked ones in order, delete the unticked ones, insert the new proposal after them, cap the total at 30 (spec FR-016, research 7). If the update of the run row matches nothing (already reaped), the transaction rolls back and the checklist is untouched.
- Ticking updates one row: `UPDATE plan_items SET done = $4 WHERE id = $1 AND user_id = $2 AND workspace_id = $3 RETURNING …`. A row that is not this person's and workspace's matches nothing and is `404`.
- Chat reads the same rows unchanged (`chat/context.ts`, limit 30, ordered by `sort_order, id`).

## Indexes (`010_agents.sql`)

```sql
-- one run at a time per person, workspace, and agent
CREATE UNIQUE INDEX IF NOT EXISTS action_runs_one_running_idx
  ON action_runs (user_id, workspace_id, action_id) WHERE status = 'pending';

-- latest runs and history for a workspace agent
CREATE INDEX IF NOT EXISTS action_runs_workspace_agent_created_idx
  ON action_runs (user_id, workspace_id, action_id, created_at DESC, id DESC);

-- the checklist read (agents card and chat)
CREATE INDEX IF NOT EXISTS plan_items_workspace_order_idx
  ON plan_items (user_id, workspace_id, sort_order, id);
```

## Volume and scale

At most 10 (plus at most one preserved) runs per agent per workspace, 5 agents, so at most about 55 rows per workspace, each with a result of a few kilobytes. `plan_items` is capped at 30 per workspace. Reads are by `(user_id, workspace_id)` and hit the indexes above.

## Shared response types (`packages/shared/src/agents.ts`)

Full definitions: [contracts/shared-agent-types.md](./contracts/shared-agent-types.md). Existing `ActionRun`/`PlanItem` in `domain.ts` are unchanged and are the stored shapes; the new file adds the response shapes the card reads (`AgentDescriptor`, `AgentRunView`, `WorkspaceAgents`, `AgentRunPage`, `AgentResult`, and the error codes).

## Entities from the spec, mapped

| Spec entity | Stored as |
| --- | --- |
| Agent | Not stored: a fixed catalog in code (`agents/catalog.ts`) returned by the list call. |
| Agent run | `action_runs` row. |
| Agent result | `action_runs.output.result` plus `sources` and `coverage`. |
| Plan item | `plan_items` row. |
| Tab, Workspace, Message | Existing tables, read only by an agent. |
