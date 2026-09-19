# Data Model: AI Clustering

Canonical TypeScript types go in `@ai-browser/shared` (new file `packages/shared/src/clustering.ts`, plus one field added to `TabRef` in `domain.ts`). Physical changes go in a **new** idempotent migration, `packages/shared/sql/004_clustering.sql`; `001_init.sql` is not edited.

All rows are user-scoped, and child rows use the same composite `(id, user_id)` foreign keys as 001, so a row can never point at another user's parent.

## Changed: `tab_refs`

| Column | Type | Rules |
| --- | --- | --- |
| `placement_source` | `TEXT NULL`, `CHECK (placement_source IN ('ai','user'))` | `NULL` = never placed (a clustering candidate if also in Other). `'user'` = the user placed it, including deliberately leaving it in Other. `'ai'` = a clustering run placed it. |

Shared type: `TabRef.placementSource: PlacementSource | null`. The 002 wire types derive from `TabRef` with `Pick` on named fields, so they do not change.

**Who writes it**

| Writer | Effect |
| --- | --- |
| Ingestion (002) | never touches it |
| `PATCH /api/tab-refs/:id` and `PUT /api/tab-refs` with `workspaceId` present (003) | set `'user'`; if the tab was `'ai'` and the workspace changed, also insert a `corrections` row |
| Clustering apply | set `'ai'`, only on a tab that is still Other and `NULL` |
| Suggestion accept | set `'user'` (the user confirmed) |
| Undo | reset to `NULL`, only on tabs still `'ai'` in the run's workspace |

**Backfill** (in the migration, guarded so re-running is harmless): `UPDATE tab_refs SET placement_source = 'user' WHERE workspace_id IS NOT NULL AND placement_source IS NULL`. Before this feature every assignment was manual.

## New: `cluster_runs`

One execution of clustering for a user. The unit the user can undo.

| Column | Type | Rules |
| --- | --- | --- |
| `id` | `UUID` PK | server-generated |
| `user_id` | `UUID NOT NULL` → `users` `ON DELETE CASCADE` | from auth |
| `status` | `TEXT NOT NULL` | `running` \| `succeeded` \| `failed` \| `undone` |
| `started_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `finished_at` | `TIMESTAMPTZ NULL` | set when leaving `running` |
| `considered_count` | `INT NOT NULL DEFAULT 0` | candidate tabs sent to the model |
| `left_out_count` | `INT NOT NULL DEFAULT 0` | candidates beyond the per-run cap |
| `applied_count` | `INT NOT NULL DEFAULT 0` | tabs actually moved |
| `suggestion_count` | `INT NOT NULL DEFAULT 0` | suggestions created or refreshed |
| `discarded_count` | `INT NOT NULL DEFAULT 0` | proposed groups thrown away by validation |
| `input_fingerprint` | `TEXT NULL` | state the run started from |
| `settled_fingerprint` | `TEXT NULL` | state after the run's changes; what the next run compares against |
| `created_workspace_ids` | `UUID[] NOT NULL DEFAULT '{}'` | workspaces this run created |
| `error` | `TEXT NULL` | generic failure text; never page content |
| `undone_at` | `TIMESTAMPTZ NULL` | |
| | `UNIQUE (id, user_id)` | target for child foreign keys |

- `CREATE UNIQUE INDEX ... ON cluster_runs (user_id) WHERE status = 'running'`: at most one running run per user.
- `CREATE INDEX ... ON cluster_runs (user_id, started_at DESC)`.

**Transitions**: `running` → `succeeded` | `failed`; `succeeded` → `undone`. Nothing leaves `failed` or `undone`. A `running` row older than 120 s is moved to `failed` ("timed out") before a new run starts.

## New: `cluster_run_moves`

The undo log: every tab a run moved.

| Column | Type | Rules |
| --- | --- | --- |
| `run_id` | `UUID NOT NULL` | |
| `user_id` | `UUID NOT NULL` | |
| `tab_ref_id` | `UUID NOT NULL` | |
| `to_workspace_id` | `UUID NOT NULL` | where the run put it |
| | `PRIMARY KEY (run_id, tab_ref_id)` | |
| | `FOREIGN KEY (run_id, user_id)` → `cluster_runs (id, user_id)` `ON DELETE CASCADE` | |
| | `FOREIGN KEY (tab_ref_id, user_id)` → `tab_refs (id, user_id)` `ON DELETE CASCADE` | |
| | `FOREIGN KEY (to_workspace_id, user_id)` → `workspaces (id, user_id)` `ON DELETE CASCADE` | |

No "from" columns: only unplaced Other tabs are ever moved, so the prior state is always "Other, `NULL`".

## New: `suggestions`

A stored, user-facing proposal. Never moves a tab until accepted.

| Column | Type | Rules |
| --- | --- | --- |
| `id` | `UUID` PK | |
| `user_id` | `UUID NOT NULL` → `users` `ON DELETE CASCADE` | |
| `run_id` | `UUID NOT NULL` | the run that created (or last refreshed) it |
| `name` | `TEXT NOT NULL`, `CHECK (char_length(name) BETWEEN 1 AND 80)` | proposed workspace name |
| `emoji` | `TEXT NULL` | |
| `target_workspace_id` | `UUID NULL` | set when the group belongs in an existing active workspace |
| `confidence` | `REAL NOT NULL`, `CHECK (confidence >= 0 AND confidence <= 1)` | |
| `tab_ref_ids` | `UUID[] NOT NULL`, `CHECK (cardinality(tab_ref_ids) >= 2)` | proposed members; not mutated after insert |
| `status` | `TEXT NOT NULL DEFAULT 'pending'` | `pending` \| `accepted` \| `ignored` \| `withdrawn` |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `resolved_at` | `TIMESTAMPTZ NULL` | set when leaving `pending` |
| | `UNIQUE (id, user_id)` | |
| | `FOREIGN KEY (run_id, user_id)` → `cluster_runs (id, user_id)` `ON DELETE CASCADE` | |
| | `FOREIGN KEY (target_workspace_id, user_id)` → `workspaces (id, user_id)` `ON DELETE CASCADE` | |

- `CREATE INDEX ... ON suggestions (user_id, status)`.
- **Transitions**: `pending` → `accepted` | `ignored` | `withdrawn`. `ignored` and `withdrawn` are terminal. A repeated ignore is accepted as a no-op.
- **Member integrity**: the array has no per-element foreign key, so every read and write that expands it joins `tab_refs` on `(id, user_id)`. Members that are no longer unplaced Other tabs are dropped from what the client sees ("eligible members").
- **Withdrawal**: when a `pending` suggestion has fewer than 2 eligible members, it is set to `withdrawn` the next time it is read or a run reconciles.

## Reused, unchanged

- **`users`, `workspaces`**: as in 003. AI-created workspaces are ordinary `active` workspaces; nothing marks them as AI-made except their id appearing in a run's `created_workspace_ids`.
- **`tab_events`**: each moved tab (AI apply, suggestion accept, undo) appends a `reassigned` event with the new `workspace_id` (`NULL` on undo).
- **`corrections`**: one row when a user moves a tab that is `'ai'`-placed (from workspace, to workspace or `NULL`, tab ref, url). No new columns.

## Shared types (`packages/shared/src/clustering.ts`)

See [contracts/shared-clustering-types.md](./contracts/shared-clustering-types.md). Summary: `PlacementSource`, `ClusterRunStatus`, `SuggestionStatus`, `ClusterRun`, `Suggestion`, `SuggestionView`, plus response shapes for the routes. `Workspace`, `TabRef`, and `TabEvent` are reused; only `TabRef` gains `placementSource`.

## Algorithm (server side)

1. **Guard**: reap a stale `running` row; insert a `running` `cluster_runs` row. A unique violation is `409 run_in_progress`.
2. **Read**: active workspaces `(id, name)`; candidates (Other, `placement_source IS NULL`, `http(s)`, open first then newest), capped at 100; record `left_out_count`.
3. **Skip check**: build `input_fingerprint`. If it equals the latest `succeeded`/`undone` run's `settled_fingerprint` and `force` is false, delete the guard row and answer `skipped`. If there are fewer than 2 candidates, finish `succeeded` with nothing found (no model call).
4. **Ask the model** (no DB transaction open): prompt from candidates and workspaces; timeout 25 s.
5. **Validate** the answer (research §4); count discarded groups.
6. **Apply** in one transaction, one savepoint per group, highest confidence first:
   - Check overlap first: compare the group with the user's stored suggestions (Jaccard `>= 0.7`, research §7). An **ignored** look-alike drops the group at any confidence. A **pending** look-alike is refreshed in place when the group is below the bar, or set `withdrawn` (superseded) when the group is applied.
   - Resolve the target: valid `existingWorkspaceId`, else active workspace with the same name (case-insensitive), else a new workspace.
   - Confidence `>= bar`: create the workspace if new, conditionally move the tabs to it, write `cluster_run_moves` and `reassigned` events. Fewer than 2 tabs moved: roll back this group's savepoint.
   - Confidence `< bar`: create a new `suggestion`, or refresh the pending look-alike found above.
   - Withdraw stale pending suggestions.
   - Compute `settled_fingerprint`; set the run `succeeded` with counts.
7. **Failure** at any point after step 1: mark the run `failed`, change nothing else, respond with the error.

**Accept a suggestion**: in one transaction, lock the suggestion; require `pending`; compute eligible members; fewer than 2 → `withdrawn`, `409 stale`. Resolve the target as above; assign the eligible members with `placement_source = 'user'`; write `reassigned` events; mark `accepted`.

**Undo a run**: in one transaction, lock the run; if `undone` answer success with zero reverted; if not `succeeded`, `409 not_undoable`. Revert moves that are still `ai` in the run's workspace; archive created workspaces that are now empty and untouched (`updated_at = created_at`, still `active`); write `reassigned` events; recompute `settled_fingerprint` from the reverted state; set `undone` and `undone_at`.

## Constants

| Name | Value | Where |
| --- | --- | --- |
| `MAX_TABS_PER_RUN` | 100 | code constant |
| `MIN_GROUP_SIZE` | 2 | code constant |
| `CLUSTER_CONFIDENCE_BAR` | 0.7 | env, optional |
| Prompt caps | title 200, URL 200, snippet 600 | code constants |
| Model timeout | 25 s | code constant |
| Stale `running` after | 120 s | code constant |
| Suggestion overlap threshold | 0.7 | code constant |
