---
description: "Task list for 004 AI Clustering"
---

# Tasks: AI Clustering

**Input**: Design documents from `/specs/004-ai-clustering/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/http.md, contracts/model.md, contracts/shared-clustering-types.md, quickstart.md

**Tests**: Included, as the plan specifies: Vitest integration tests on PGlite with an injected fake model (`tests/cluster*.test.ts`), plus one opt-in live check. They never touch Tiger and never call the network by default. Drop the test tasks (T014, T015, T025, T033, T037, T043, T048) if you want none; nothing else depends on them.

**Organization**: Grouped by user story from spec.md (US1–US5). US1–US4 are P1 and US5 is P2.

**Change after implementation (2026-09-19):** the AI provider became configurable: the VT ARC LLM API is the default and Gemini the selectable backup. `llm/gemini.ts` (T010) is now one of two providers behind `llm/index.ts`, alongside `llm/openai-compat.ts` and `llm/limiter.ts`. See research section 19 and the plan's "Stack pivot" note. The tasks below are otherwise unchanged.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1–US5, only inside story phases
- Paths are from the repository root.

**Rules for the implementer**
- Before writing route handlers, read `apps/web/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` and the `02-route-segment-config` docs (`apps/web/AGENTS.md`: this Next.js version differs from older ones). Existing routes show the pattern: `params` is a `Promise`, every handler starts with `requireUser`, and responses use `src/json.ts`.
- Every SQL statement is parameterized and filters by `user_id`.
- Never log tab titles, URLs, snippets, prompts, or model output. Log counts and ids only.
- Every model request goes through `apps/web/src/llm/` (client and daily budget, research §18). Never call Gemini directly from a route, and never retry a 429.
- Never run anything against the Tiger database in this task list except where a task says it needs the user's approval (T050, T051).
- Do not edit `spec.md`, `plan.md`, or `data-model.md`; if reality contradicts them, stop and say so.

---

## Phase 1: Setup

**Purpose**: Config and a way to apply SQL without `psql` (not installed on the dev machine).

- [x] T001 Add to the LLM section of the root `.env.example`: commented `# GEMINI_MODEL=gemini-3.5-flash-lite`, `# CLUSTER_CONFIDENCE_BAR=0.7`, and `# LLM_DAILY_CAP=450`, each with a one-line explanation (default model `gemini-3.5-flash-lite` was verified callable on 2026-09-19 and chosen for its higher rate limits; `gemini-2.5-flash` is listed but returns 404 for new users; groups at or above the bar auto-apply and below it become suggestions; the cap is the in-memory guardrail on model requests per Pacific-time day, kept under the free tier's 500). `GEMINI_API_KEY` is already listed there.
- [x] T002 [P] Create `apps/web/scripts/apply-sql.mjs`: a Node script taking one path argument (a `.sql` file), loading the repo-root `.env` the same way `apps/web/src/db.ts` does (an already-set variable is never overridden), normalizing `sslmode` the same way (`sslmode=require` when absent), running the whole file in a single `pg` query, and printing only the database **host** and "applied". It exits non-zero on error, prints usage with no argument, and never prints `DATABASE_URL` or any credential.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared types, migration, mappers, placement bookkeeping in the existing routes, the model adapter, and test plumbing. MUST complete before any story.

**⚠️ CRITICAL**: No story work can begin until this phase is complete.

- [x] T003 [P] In `packages/shared/src/domain.ts`, add `export type PlacementSource = "ai" | "user";` and a `placementSource: PlacementSource | null` field on `TabRef` with the doc comment from `contracts/shared-clustering-types.md`. Do not change any other type.
- [x] T004 [P] Create `packages/shared/src/clustering.ts` with `ClusterRunStatus`, `SuggestionStatus`, `ClusterRun`, `Suggestion`, `SuggestionView`, and `AppliedGroup` exactly as in `contracts/shared-clustering-types.md`, and add `export * from "./clustering";` to `packages/shared/src/index.ts`.
- [x] T005 [P] Create `packages/shared/sql/004_clustering.sql` per `data-model.md`, fully idempotent: `ALTER TABLE tab_refs ADD COLUMN IF NOT EXISTS placement_source` with its `CHECK (IN ('ai','user'))` (add the check so a re-run does not fail); `CREATE TABLE IF NOT EXISTS` for `cluster_runs`, `cluster_run_moves`, and `suggestions` with every column, check, `UNIQUE (id, user_id)`, and composite foreign key listed there; the partial unique index `ON cluster_runs (user_id) WHERE status = 'running'`; the two other indexes; and the backfill `UPDATE tab_refs SET placement_source = 'user' WHERE workspace_id IS NOT NULL AND placement_source IS NULL`. Put a header comment saying it requires 001 first and is safe to re-run. Do not edit `001_init.sql`.
- [x] T006 In `apps/web/src/map.ts`: add `placement_source` to `DbTabRef` and `placementSource` to `mapTabRef`; export a `TAB_REF_COLUMNS` constant holding the column list (`id, user_id, workspace_id, url, title, snippet, chrome_tab_id, last_seen_at, placement_source`); add `DbClusterRun` / `DbSuggestion` row types and `mapClusterRun` / `mapSuggestion` mappers to the shared `ClusterRun` / `Suggestion` types (timestamps to ISO strings, `real` confidence to number, UUID arrays as string arrays). (depends on T003, T004)
- [x] T007 Replace every hardcoded `tab_refs` column list that feeds `mapTabRef` with `TAB_REF_COLUMNS`: `apps/web/app/api/tab-refs/route.ts` (the `GET` select and the `RETURNING` clauses of the `PUT` update and insert), `apps/web/app/api/tab-refs/[id]/route.ts` (the two selects and the `RETURNING`), and `apps/web/app/api/resolve/route.ts` (both selects). Behavior must not change beyond the extra field. (depends on T006)
- [x] T008 In `apps/web/app/api/tab-refs/route.ts` (`PUT`) and `apps/web/app/api/tab-refs/[id]/route.ts` (`PATCH`): when the request sets `workspaceId` (including `null`), also set `placement_source = 'user'` on the row (insert and update paths); when `workspaceId` is absent leave it unchanged (`NULL` on insert). `POST /api/ingest/tabs` (`apps/web/src/ingest.ts`) must stay untouched. (depends on T007)
- [x] T009 [P] Create the shared AI plumbing in `apps/web/src/llm/`: `errors.ts` (`ModelError`, `ModelUnconfiguredError`, `BudgetExceededError`; generic messages only, never prompt text, tab content, or vendor response bodies) and `budget.ts` per research §18: an in-memory counter per Pacific-time day; `spend(purpose)` increments **before** a request is sent and throws `BudgetExceededError` when the global cap `LLM_DAILY_CAP` (default 450) or the purpose's share plus the shared spill-over pool is used up; purposes `cluster`, `chat`, `plan`, `actions`, `command` with the default shares from research §18; a `resetForTests()`; no database.
- [x] T010 Create `apps/web/src/llm/gemini.ts` (the only vendor-specific file) and `apps/web/src/cluster/model.ts`. `gemini.ts` exports `generateJson({ purpose, prompt, schema, signal })`: call `spend(purpose)` first; model id from `GEMINI_MODEL_<PURPOSE>`, else `GEMINI_MODEL`, else `gemini-3.5-flash-lite`; key from `GEMINI_API_KEY` (empty → `ModelUnconfiguredError`); `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` with header `x-goog-api-key`, one user part, and `generationConfig` = `{ temperature: 0.2, responseMimeType: "application/json", responseSchema: <caller's schema>, thinkingConfig: { thinkingLevel: "minimal" } }` (use `thinkingLevel`, **not** `thinkingBudget`: the lite model rejects `thinkingBudget: 0` with HTTP 400); read `candidates[0].content.parts[0].text` and `JSON.parse` it. **One total 25 s deadline** (combined with the caller's `AbortSignal`) covers the call and its retry. HTTP 429 → `BudgetExceededError`, **never retried**. HTTP 503 → one retry after about 1 s only if the deadline allows. HTTP 404 → `ModelError` naming the model id and telling the operator to change `GEMINI_MODEL`. Everything else (other HTTP errors, network errors, timeouts, non-JSON, missing `groups` array) → a generic `ModelError`. `model.ts` defines `ClusterModelInput`, `ProposedGroup`, `ClusterModel` (see `contracts/model.md`), `MAX_TABS_PER_RUN = 100`, `MIN_GROUP_SIZE = 2`, `confidenceBar()` (reads `CLUSTER_CONFIDENCE_BAR`, default `0.7`, ignore invalid values), `getModel()` (the override if set, else a model whose `propose` calls `generateJson({ purpose: "cluster", ... })`), and the test seam `setModelForTests(model | null)`. (depends on T009)
- [x] T011 In `apps/web/tests/global-setup.ts`: after applying `001_init.sql` also apply `packages/shared/sql/004_clustering.sql` to PGlite, and set `process.env.GEMINI_API_KEY = ""` (explicitly, so `src/db.ts` never loads the real key from `.env`) unless `process.env.CLUSTER_LIVE === "1"`. Update the doc comment accordingly. (depends on T005)
- [x] T012 Create `apps/web/tests/cluster-helpers.ts`: `fakeModel(handler)` returning a `ClusterModel` that records each call's input and returns canned raw groups (with a call counter) or throws; a `gate()` helper (a promise the test releases) so a fake model call can be held open, needed by the overlapping-run and stale-run tests; an `installFakeModel` wrapper using `setModelForTests` (cleared afterwards, and calling `resetForTests()` on the budget); a `seedTabs(token, tabs)` that sends a valid batch through the ingest route using the existing helpers (`req`, `batch`, `tab`); and small wrappers for creating workspaces and reading tabs. (depends on T010, T011)
- [x] T013 Update `apps/web/tests/existing-routes.test.ts`: add cases that `PUT`/`PATCH` with `workspaceId` (including `null`) yield `placementSource: "user"`, that a `PUT` without `workspaceId` leaves it unchanged, that an ingested tab has `placementSource: null`, and that `GET /api/resolve` and `GET /api/tab-refs` include the field. Fix any existing assertion the new field breaks. (depends on T008, T011)

**Checkpoint**: `pnpm -r typecheck` and `pnpm --filter @ai-browser/web test` pass with the new field and migration in place.

---

## Phase 3: User Story 1 - A messy tab set becomes named workspaces (Priority: P1) 🎯 MVP

**Goal**: One request organizes a user's unplaced tabs: confident groups become named workspaces with tabs assigned, unrelated tabs stay in Other, a repeat run with nothing changed does not call the model, and failures change nothing.

**Independent Test**: Seed 30 mixed tabs in Other with a fake model returning three confident groups; run clustering. Three workspaces (name + emoji) exist holding the right tabs, the one-offs are still in Other, `placementSource` is `"ai"` on the moved tabs, and running again without `force` returns `skipped` with no second model call. With a model that throws, nothing changes.

### Tests for User Story 1 ⚠️ (write first; they fail until the implementation exists)

- [x] T014 [P] [US1] Create `apps/web/tests/cluster-prompt.test.ts` covering `prompt.ts`: title cut to 200, URL stripped of query string and fragment and cut to 200, snippet cut to 600, short ids `t1..tN`, no fields beyond id/title/url/snippet and the workspaces list; validation rules from `contracts/model.md` (unknown or repeated tab ids dropped, tab claimed by two groups goes to the higher confidence, fewer than 2 tabs discards the group and counts it, non-finite or out-of-range confidence discards, blank/over-80/`Other`/generic names discard, unknown `existingWorkspaceId` becomes null, non-object answer or missing `groups` array throws `ModelError`, an empty `groups` array is valid).
- [x] T015 [US1] Create `apps/web/tests/cluster.test.ts` (later stories append their own `describe` blocks to this file) with the US1 block, using `cluster-helpers.ts`: confident groups create workspaces and assign tabs (`placementSource "ai"`, `cluster_run_moves` rows, `reassigned` events); unrelated tabs stay Other and unplaced; a tab with an empty snippet is still sent to the model; fewer than 2 candidates finishes `succeeded` with no model call; more than 100 candidates sends 100 and reports `leftOut`; an unchanged second run returns `skipped: true` and makes no model call, while `force: true` runs again without duplicating workspaces; a model that throws `ModelError` gives `502`, run `failed`, and no tab/workspace change; a `BudgetExceededError` (and a `LLM_DAILY_CAP` of 1 on the second call) gives `429 budget_exhausted`, a `failed` run, and no change; no key (the default in tests) gives `503` and no run row; missing token gives `401`; two overlapping runs (hold the first open with `gate()`) give one `200` and one `409 run_in_progress`; a `running` row older than 120 s is reaped; user B never sees or affects user A's data. (depends on T012)

### Implementation for User Story 1

- [x] T016 [P] [US1] Create `apps/web/src/cluster/prompt.ts` (pure, no DB): `buildRequest(candidates, workspaces)` → `{ input: ClusterModelInput, idMap }` applying the caps, URL stripping, and short ids from `contracts/model.md`; `validateAnswer(raw, idMap, workspaces)` → `{ groups: ProposedGroup[] (tab-ref ids resolved), discarded: number }` applying every rule in the table there, throwing `ModelError` only for a wrong top-level shape.
- [x] T017 [P] [US1] Create `apps/web/src/cluster/fingerprint.ts` (pure): `fingerprint(candidates, workspaces)` = SHA-256 hex over a stable JSON of candidate `(id, url, title, sha256(snippet))` sorted by id plus workspaces `(id, name)` sorted by id; and `jaccard(a: string[], b: string[])`.
- [x] T018 [US1] Create `apps/web/src/cluster/apply.ts`: `applyGroups(client, userId, runId, groups, confidenceBar)` run inside the caller's transaction. Process groups by descending confidence, one `SAVEPOINT` each. For a group at or above the bar: create a new active workspace (name, emoji), collect its id, move each tab with the conditional update `SET workspace_id = $to, placement_source = 'ai' WHERE id = $id AND user_id = $user AND workspace_id IS NULL AND placement_source IS NULL`, insert a `cluster_run_moves` row and a `reassigned` `tab_events` row per moved tab; if fewer than `MIN_GROUP_SIZE` tabs actually moved, `ROLLBACK TO SAVEPOINT` (no orphan workspace). Return `{ applied: AppliedGroup[], createdWorkspaceIds, appliedCount }`. Groups below the bar are skipped here (US2 handles them). (depends on T016)
- [x] T019 [US1] Create `apps/web/src/cluster/run.ts` with `runClustering(userId, { force })` implementing `data-model.md` "Algorithm" steps 1–7 in this order: (0) call `getModel()` first, so `ModelUnconfiguredError` is thrown before anything is written; (1) reap a stale `running` row (older than 120 s → `failed`) and insert the `running` row (unique violation → a typed `RunInProgress` error); (2) load active workspaces and candidates (Other, `placement_source IS NULL`, `http(s)` URL, open tabs first then `last_seen_at DESC`, capped at `MAX_TABS_PER_RUN`, recording `left_out_count`); (3) skip check against the latest `succeeded`/`undone` run's `settled_fingerprint` unless `force` (delete the guard row and return `skipped`), and fewer than 2 candidates → `succeeded` with nothing found and no model call; (4) call `model.propose(...)` with **no transaction open**; (5) `validateAnswer`; (6) `withTransaction` → `applyGroups`, compute `settled_fingerprint`, update the run with counts, `status = 'succeeded'`, `created_workspace_ids`, `finished_at`; on any error mark the run `failed` with a generic message and rethrow typed errors (`ModelError`, `BudgetExceededError`, `RunInProgress`). Log only run id, counts, and outcome. (depends on T016, T017, T018)
- [x] T020 [US1] Create `apps/web/app/api/cluster/runs/route.ts`: `export const runtime = "nodejs"` and a generous `maxDuration`; `OPTIONS`; `POST` (parse an optional JSON body, `400` if it is not an object or `force` is not a boolean; call `runClustering`; map `RunInProgress` → `409 { code: "run_in_progress" }`, `BudgetExceededError` → `429 { code: "budget_exhausted", runId }`, `ModelError` → `502 { code: "model_error", runId }`, `ModelUnconfiguredError` → `503 { code: "model_unconfigured" }`; success → `200` with `{ skipped, reason?, run, applied, suggestions, leftOut }`, `suggestions: []` until US2); `GET` (list this user's runs newest first, `limit` default 20 max 50, mapped with `mapClusterRun`). (depends on T019)
- [x] T021 [P] [US1] Create the reference fixtures in `apps/web/tests/fixtures/`. `mixed-tabs.batch.json`: a valid ingest batch (`fullSnapshot: true`, **`events: []`**, because `tab_events` ids are unique across users and replaying them under a second token would be silently deduplicated) with 30 http(s) tabs, distinct `chromeTabId` and URLs, realistic titles and short snippets: about 9 on planning a trip, 9 on a coding project, 5 on cooking, 4 deliberately **ambiguous** (could be work or leisure: newsletters, a reading list), and 3 unrelated one-offs. `mixed-tabs-50.batch.json`: the same shape with 50 tabs (the 30 plus 20 more on the same topics), for timing. `mixed-tabs.labels.json`: `{ "labels": { url: label | null }, "ambiguous": [urls] }` (one-offs are `null`; ambiguous URLs are not scored).
- [x] T022 [P] [US1] Create `apps/web/scripts/score-lib.mjs` exporting the single SC-001 scoring function `scoreClusters(labels, ambiguous, workspaceByUrl)`: a tab counts as correct when its workspace is the one most of that label's tabs share (a `null`-label tab is correct when it is still in Other); ambiguous URLs are skipped; returns the percentage and a per-tab mismatch list. Then create `apps/web/scripts/score-clusters.mjs <deviceToken>`: reads the repo-root `.env`, reads `GET /api/tab-refs` and `GET /api/workspaces` from `http://localhost:3000` (or `API_BASE`) with that token, scores them against `mixed-tabs.labels.json` using `score-lib.mjs`, and prints the result. Never prints the token.
- [x] T023 [US1] Create `apps/web/tests/cluster-live.test.ts`: `describe.skipIf(process.env.CLUSTER_LIVE !== "1")` — seed `mixed-tabs.batch.json` into PGlite, run clustering with the **real** Gemini client, and assert `scoreClusters` (imported from `apps/web/scripts/score-lib.mjs`, so it is the same function the CLI uses) is at least 80% (SC-001); then, under a fresh token, seed `mixed-tabs-50.batch.json`, run once, and assert it finished within 30 s (SC-006, a single sample; quickstart V9 takes ten). Document at the top: `CLUSTER_LIVE=1 pnpm --filter @ai-browser/web test cluster-live` costs about 2 model requests and runs on PGlite, never Tiger. (depends on T021, T022, T020)
- [x] T024 [US1] Run `pnpm -r typecheck` and `pnpm --filter @ai-browser/web test`; fix failures until T014 and T015 pass.

**Checkpoint**: User Story 1 works on its own: confident groups become workspaces, repeat runs are quiet, failures change nothing. This is the MVP.

---

## Phase 4: User Story 2 - Uncertain groups become suggestions (Priority: P1)

**Goal**: Groups below the confidence bar are stored as pending suggestions that move nothing until accepted; ignoring one stops it coming back.

**Independent Test**: A fake model returns one group at 0.9 and one at 0.5. The 0.5 group appears as a pending suggestion and its tabs are still in Other. Accepting creates the workspace and assigns the tabs as `placementSource "user"`. Ignoring another suggestion and re-running with `force` does not bring it back.

### Tests for User Story 2 ⚠️

- [x] T025 [US2] Append a US2 `describe` block to `apps/web/tests/cluster.test.ts`: a below-bar group creates a `pending` suggestion and moves nothing; a second run refreshes (not duplicates) a pending suggestion whose tab overlap is at least 0.7; a group overlapping an `ignored` suggestion by at least 0.7 is suppressed **at any confidence, including when the model now reports it at or above the bar (never auto-applied)**; a pending look-alike that is now at or above the bar is applied and the old suggestion becomes `withdrawn`; `GET /api/suggestions` returns eligible tabs only, withdraws a pending suggestion left with fewer than 2 eligible tabs, and answers `400` for an unknown `status`; accept creates the workspace, assigns tabs as `"user"`, writes `reassigned` events, and marks `accepted`; accept on a stale suggestion is `409 stale` and withdraws it; accept/ignore on a non-pending suggestion is `409 not_pending` (ignore on `ignored` is `200`); a well-formed answer with no groups is a `200` with nothing found. (depends on T024)

### Implementation for User Story 2

- [x] T026 [US2] Extend `apps/web/src/cluster/apply.ts` so overlap is checked **before** the confidence branch: compare each group with this user's stored suggestions by Jaccard similarity of tab-ref ids (`>= 0.7`, research §7). An `ignored` look-alike drops the group at any confidence. A `pending` look-alike is refreshed in place (new run id, name, confidence, tabs) when the group is below the bar, or set `withdrawn` when the group is applied. Otherwise a group at or above the bar takes the US1 apply path and a group below it creates a `pending` suggestion (name, emoji, confidence, `target_workspace_id` when it targets an existing workspace, `tab_ref_ids`). Return `suggestionCount` and the affected suggestion ids. (depends on T017, T018)
- [x] T027 [US2] Create `apps/web/src/cluster/suggestions.ts`: `toSuggestionViews(client, userId, rows)` (join `tab_refs` on `(id, user_id)`, keep only members still Other and unplaced, attach `targetWorkspace`); `listSuggestions(userId, status)` (withdraw stale `pending` ones first, newest first); `ignoreSuggestion(userId, id)`; `acceptSuggestion(userId, id)` in one transaction as in `data-model.md` ("Accept a suggestion"): lock the row, require `pending`, compute eligible members, fewer than 2 → set `withdrawn` and throw a typed `Stale` error, otherwise use `target_workspace_id` if it is an active workspace else create one, assign the eligible tabs with `placement_source = 'user'`, write `reassigned` events, set `accepted` and `resolved_at`. Typed errors for not found and not pending. (depends on T026)
- [x] T028 [US2] In `apps/web/src/cluster/run.ts`: after applying, withdraw pending suggestions that lost eligibility, and return `SuggestionView[]` for the suggestions the run created or refreshed so `POST /api/cluster/runs` fills its `suggestions` field. (depends on T027)
- [x] T029 [P] [US2] Create `apps/web/app/api/suggestions/route.ts`: `GET` with `status` = `pending` (default) | `accepted` | `ignored` | `all` (`400` otherwise) returning `{ suggestions }`; `OPTIONS`. (depends on T027)
- [x] T030 [P] [US2] Create `apps/web/app/api/suggestions/[id]/accept/route.ts`: `POST` → `200 { suggestion, workspace, created, tabRefs }`; `404` unknown or other user's id; `409 not_pending` / `409 stale`. (depends on T027)
- [x] T031 [P] [US2] Create `apps/web/app/api/suggestions/[id]/ignore/route.ts`: `POST` → `200 { suggestion }`; `404`; `409 not_pending`. (depends on T027)
- [x] T032 [US2] Run `pnpm -r typecheck` and `pnpm --filter @ai-browser/web test`; fix failures until T025 passes and US1 tests still pass.

**Checkpoint**: Stories 1 and 2 both work: confident groups apply, uncertain ones wait for the user.

---

## Phase 5: User Story 3 - Existing workspaces and Other are respected (Priority: P1)

**Goal**: New tabs join existing workspaces instead of spawning near-duplicates; user-placed tabs and tabs the user deliberately left in Other are never moved; archived workspaces are never targets.

**Independent Test**: A hand-made "Trip to Japan" workspace holds two tabs; five more Japan tabs sit in Other. Running clustering with a fake model that returns that workspace's id puts the five into it, creates no second Japan workspace, and leaves the two hand-placed tabs alone.

### Tests for User Story 3 ⚠️

- [x] T033 [US3] Append a US3 `describe` block to `apps/web/tests/cluster.test.ts`: a group with a valid `existingWorkspaceId` joins that workspace; a group whose new name matches an active workspace name case-insensitively joins it instead of creating one; the model is only told about active workspaces (archived ones absent from the input and never targeted even if named); a group named `Other` creates nothing; tabs placed by the user (in a workspace, or `placementSource 'user'` in Other) are unchanged across five consecutive runs with new tabs added between them (SC-003); accepting a suggestion whose target is an existing workspace uses it; a suggestion never targets an archived workspace. (depends on T032)

### Implementation for User Story 3

- [x] T034 [US3] Create `apps/web/src/cluster/target.ts`: `resolveTarget(client, userId, group, activeWorkspaces)` returning `{ workspaceId, created: false } | { create: { name, emoji } }` using, in order, a valid `existingWorkspaceId`, then a case-insensitive trimmed name match against **active** workspaces only, else create. A name equal to `Other` (any case) is rejected as a defensive second check after validation. (depends on T033)
- [x] T035 [US3] Use `resolveTarget` in `apps/web/src/cluster/apply.ts` (confident groups reuse the target and only create when none matches; reused workspaces are not added to `createdWorkspaceIds`; suggestions record `target_workspace_id`) and in `acceptSuggestion` in `apps/web/src/cluster/suggestions.ts` (same rule, so accept also avoids duplicates). (depends on T034)
- [x] T036 [US3] Run `pnpm -r typecheck` and `pnpm --filter @ai-browser/web test`; fix failures until T033 passes and earlier stories still pass.

**Checkpoint**: Stories 1–3 work together; repeat runs build on the user's own organization.

---

## Phase 6: User Story 4 - AI grouping is always reversible (Priority: P1)

**Goal**: A whole run can be undone; a tab the user moved keeps the user's placement; the origin of every placement is known; overriding an AI placement is recorded as a signal.

**Independent Test**: Run clustering so it creates two workspaces; undo the run: tabs return to Other unplaced and the empty, untouched workspaces are archived. Redo, move one AI tab by hand, undo again: that tab stays where the user put it and its workspace stays.

### Tests for User Story 4 ⚠️

- [x] T037 [US4] Append a US4 `describe` block to `apps/web/tests/cluster.test.ts`: undo reverts moved tabs to `workspace_id NULL, placement_source NULL` and appends `reassigned` events; created workspaces that are empty and have `updated_at = created_at` are archived, a renamed one or one holding a user-added tab is kept; a tab moved by the user since is reported in `keptTabRefIds` and untouched; undoing an undone run is `200` with `reverted: 0`; undoing a `running` or `failed` run is `409 not_undoable`; after an undo, a non-forced run is `skipped` (settled fingerprint refreshed); a user `PATCH`/`PUT` that moves an `ai` tab makes it `"user"` and writes one `corrections` row (from, to, tab ref, url), and moving a `"user"` or unplaced tab writes none; a later forced run does not move that tab; `GET /api/cluster/runs/:id` lists moves with `stillAiPlaced`; another user's run id is `404`. (depends on T036)

### Implementation for User Story 4

- [x] T038 [US4] Create `apps/web/src/cluster/undo.ts` (`undoRun(userId, runId)`) as in `data-model.md` ("Undo a run"): one transaction; lock the run `FOR UPDATE`; already `undone` → success with zero reverted; not `succeeded` → typed `NotUndoable`; revert only moves where `workspace_id = to_workspace_id AND placement_source = 'ai'`; collect `keptTabRefIds` for moves the user changed; archive each `created_workspace_ids` workspace that is `active`, has no tabs left, and has `updated_at = created_at`; append `reassigned` events; recompute `settled_fingerprint` from the reverted state; set `status 'undone'` and `undone_at`. Return `{ run, reverted, keptTabRefIds, archivedWorkspaceIds }`. (depends on T017)
- [x] T039 [P] [US4] Create `apps/web/app/api/cluster/runs/[id]/undo/route.ts`: `POST` → `200` body from `undoRun`; `404` unknown or other user's run; `409 not_undoable`; `OPTIONS`. (depends on T038)
- [x] T040 [P] [US4] Create `apps/web/app/api/cluster/runs/[id]/route.ts`: `GET` → `200 { run, moves: [{ tabRefId, toWorkspaceId, stillAiPlaced }] }` (compute `stillAiPlaced` by joining `tab_refs`); `404` for unknown or other user's id; `OPTIONS`.
- [x] T041 [US4] In `apps/web/app/api/tab-refs/route.ts` (`PUT`) and `apps/web/app/api/tab-refs/[id]/route.ts` (`PATCH`): widen the pre-read selects so they also return `placement_source` (in `route.ts` the two `SELECT id, workspace_id ...` lookups; in `[id]/route.ts` the existence check that currently selects only `id`), and when the request sets `workspaceId`, the previous source was `'ai'`, and the workspace actually changes, insert one `corrections` row (`from_workspace_id`, `to_workspace_id`, `tab_ref_id`, `url`) in the same request. No correction for `'user'`, unplaced, or unchanged placements. (depends on T008)
- [x] T042 [US4] Run `pnpm -r typecheck` and `pnpm --filter @ai-browser/web test`; fix failures until T037 passes and earlier stories still pass.

**Checkpoint**: Stories 1–4 work: everything the AI does can be taken back, and the user's word is final.

---

## Phase 7: User Story 5 - Home and the sidebar can read the results (Priority: P2)

**Goal**: One call gives Home every workspace with its tabs, Other, and pending suggestions; the sidebar's resolve call says whether a tab was AI-placed.

**Independent Test**: After a run, `GET /api/overview` returns workspaces with tabs, `other`, and pending suggestions together; `GET /api/resolve` for an AI-placed tab returns `placementSource "ai"`; another user sees none of it; an unauthenticated call is `401`.

### Tests for User Story 5 ⚠️

- [x] T043 [US5] Append a US5 `describe` block to `apps/web/tests/cluster.test.ts`: `GET /api/overview` returns `{ workspaces: [{ workspace, tabRefs }], other, suggestions }` with archived workspaces excluded unless `includeArchived=true` and every tab carrying `placementSource`; `GET /api/resolve` returns `placementSource "ai"` for an AI-placed tab and `"user"` after the user moves it; ids in overview equal the ids from `GET /api/workspaces`; a second user's overview, suggestions, and runs are empty of the first user's data; missing token is `401` on every new route. (depends on T042)

### Implementation for User Story 5

- [x] T044 [US5] Create `apps/web/app/api/overview/route.ts`: `GET` for the authenticated user with `includeArchived` query; three user-scoped queries (workspaces in creation order, all their tab refs via `TAB_REF_COLUMNS`, pending suggestions via `toSuggestionViews`), group tabs by workspace, put `workspace_id IS NULL` tabs in `other`, return the shape in `contracts/http.md`; `OPTIONS`. (depends on T027)
- [x] T045 [US5] Run `pnpm -r typecheck` and `pnpm --filter @ai-browser/web test`; fix failures until T043 passes and earlier stories still pass.

**Checkpoint**: All five stories work; Home (005) and the sidebar (006) can be built against this.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Contract docs, log safety, full validation, and the steps that touch shared systems.

- [x] T046 [P] Update `specs/003-workspace-persistence-api/contracts/http.md`: note that every `TabRef` now carries `placementSource`, and that `PUT /api/tab-refs` and `PATCH /api/tab-refs/:id` set it to `user` (and record a correction when overriding an AI placement) when `workspaceId` is sent. Flag this edit to the user in the final report (cross-feature change).
- [x] T047 [P] Update `apps/web/README.md`: add the clustering routes to the routes table, a short "Clustering" section (what runs on request, `GEMINI_API_KEY`/`GEMINI_MODEL`/`CLUSTER_CONFIDENCE_BAR`, how to apply the migration with `apps/web/scripts/apply-sql.mjs`, the opt-in `CLUSTER_LIVE=1` test).
- [x] T048 Add a log-safety test to `apps/web/tests/cluster.test.ts`: spy on `console.log`/`info`/`warn`/`error` during a successful run and a failing run and assert that no tab title, URL, snippet, or model-answer text appears in any logged argument. Fix any code that violates it. (depends on T042)
- [x] T049 Full validation: `pnpm -r typecheck`, `pnpm --filter @ai-browser/web test`, `pnpm --filter @ai-browser/extension test`; confirm the extension's 244 tests are unchanged and that `git status` shows no `.env` and no `dist/` files. (depends on T045, T048)
- [x] T050 (manual, **needs the user's explicit approval**: writes to the shared Tiger database) Run `node apps/web/scripts/apply-sql.mjs packages/shared/sql/004_clustering.sql` against the database in `.env`; then confirm with a read-only check that `tab_refs.placement_source` exists, the three tables exist, and the backfill set `placement_source = 'user'` only on tabs that have a workspace. (depends on T049)
- [x] T051 (manual, needs the user; calls Gemini and writes test rows to Tiger) Run `specs/004-ai-clustering/quickstart.md` scenarios V1–V9 against the real server and database with fresh `e2e-cluster-…` tokens; record the SC-001 score and the V9 timing; tune `CLUSTER_CONFIDENCE_BAR` only if the score is under 80%; fix failures. List the test rows left behind so the user can decide on cleanup. (depends on T050)
- [x] T052 Only after T049–T051 pass: set the 004 row in `FEATURES.md` to `☑ implemented`. (depends on T051)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none; T001 and T002 can run in parallel.
- **Foundational (Phase 2)**: after Setup; blocks every story. Order: T003/T004/T005/T009 in parallel → T006 → T007 → T008; T010 after T009; T011 after T005; T012 after T010+T011; T013 after T008+T011.
- **US1 (Phase 3)** after Foundational. **US2, US3, US4, US5** each build on `apply.ts`/`run.ts`/`suggestions.ts` from earlier phases, so run them in priority order (US1 → US2 → US3 → US4 → US5). They are independently *testable* (each Independent Test above passes with only the stories before it), not independently parallelizable, because they edit the same files.
- **Polish (Phase 8)** after all stories; T050–T052 are manual and in order.

### Within Each Story

- Test tasks first; they fail until the implementation lands.
- Pure modules (`prompt.ts`, `fingerprint.ts`) → `apply.ts` → `run.ts` → routes.

### Parallel Opportunities

- Phase 1: T001, T002.
- Phase 2: T003, T004, T005, T009 together; later T011 alongside T010.
- US1: T014 with T016 and T017 (different files); T021 and T022 anytime after Foundational.
- US2: T029, T030, T031 (three separate route files) once T027 is done.
- US4: T039 and T040.
- Polish: T046 and T047.

### Parallel Example: Phase 2 start

```bash
Task: "Add PlacementSource and TabRef.placementSource in packages/shared/src/domain.ts"        # T003
Task: "Create packages/shared/src/clustering.ts and export it from index.ts"                    # T004
Task: "Create packages/shared/sql/004_clustering.sql"                                           # T005
Task: "Create apps/web/src/cluster/model.ts (interface, errors, getModel, test seam)"           # T009
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup, then Phase 2 Foundational (stop at its checkpoint).
2. Phase 3 (US1). **Stop and validate**: fake-model tests green; then, with the real key, `CLUSTER_LIVE=1 pnpm --filter @ai-browser/web test cluster-live` (runs on PGlite, safe).
3. Demo-ready core: messy tabs in, named workspaces out.

### Incremental Delivery

1. Foundation → US1 (MVP).
2. US2 adds suggestions (trust for uncertain cases).
3. US3 makes runs safe on top of existing organization.
4. US4 adds undo and the correction signal (required before anything ships to real use).
5. US5 exposes the reads that Home (005) and the sidebar (006) need.
6. Polish, then the manual database and live checks.

### Notes

- Do not apply the migration to Tiger, or call the real model against Tiger data, until T050 and T051 are approved.
- Do not commit; CLAUDE.md requires asking first. Tasks are checked off as they complete.
- If reality contradicts `plan.md`, `spec.md`, or `data-model.md` (for example a model behaves differently than research recorded), stop and say so rather than editing them.
