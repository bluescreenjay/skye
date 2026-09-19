# Implementation Plan: AI Clustering

**Branch**: `004-ai-clustering` | **Date**: 2026-09-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-ai-clustering/spec.md`

## Summary

Add server-side clustering to `apps/web`: on request, read the user's unplaced tabs (Other, never placed), ask an LLM to group them by title, URL, and snippet, then either apply confident groups (creating or reusing workspaces) or store uncertain ones as suggestions the user can accept or ignore. Every AI placement is marked `ai`, recorded per run, and undoable; user placements always win. Three new tables (`cluster_runs`, `cluster_run_moves`, `suggestions`) and one new `tab_refs` column (`placement_source`) go in a new idempotent migration. Shared types gain `PlacementSource`, `ClusterRun`, `Suggestion`, and friends. The model call goes through a shared `src/llm/` module that picks one provider per deployment: the **VT ARC LLM API by default** (OpenAI-compatible, `gpt-oss-120b`) with **Gemini as the selectable backup**, plus an in-memory daily call budget and a local concurrency limiter (research sections 18 and 19). Later AI features (008 to 011) reuse it, and a further provider is one more file. No UI, no embeddings, no extension changes.

Design detail: [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), validation: [quickstart.md](./quickstart.md).

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22, Next.js 16 App Router (`apps/web`). `apps/web/AGENTS.md` warns Next 16 differs from older versions: read `apps/web/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` (and the route-segment-config docs for `maxDuration`) before writing route handlers.

**Primary Dependencies**: `@ai-browser/shared`; `pg`; Node `crypto` (fingerprints); `fetch` for the providers' REST APIs. **No new runtime dependency.** Dev: existing Vitest + PGlite.

**Storage**: Existing Postgres (Tiger preferred). New migration `packages/shared/sql/004_clustering.sql` (idempotent). `001_init.sql` is not edited.

**Testing**: `tsc --noEmit`; Vitest against PGlite with an injected fake `ClusterModel` (no network); an opt-in live check with a real key (`CLUSTER_LIVE=1`) that scores the 30-tab fixture; the curl scenarios in [quickstart.md](./quickstart.md).

**Target Platform**: Localhost Next.js now; Vultr later. Long-running route (`maxDuration` set generously) so a hosted pivot does not cut a run short.

**Project Type**: Web API in the existing monorepo app `apps/web`, consumed later by Home (005) and the sidebar (006).

**Performance Goals**: A run over up to 50 tabs answers in under 30 s for 90% of runs (SC-006). Measured on 2026-09-19: `gemini-3.5-flash-lite` answered 8 tabs in about 1.2 s. Through the finished code, default VT provider: 30 tabs 100% in 4.1 s and 50 tabs in 5.2 s; Gemini backup 100% in 1.4 s. 50–100 tabs is verified by quickstart V9.

**Constraints**: Every query filters by `user_id`. No DB transaction is held during the model call. Model key is server-only. Logs carry counts and ids only, never tab text or model output. One total 25 s model deadline (call plus retry). One running run per user. Every model request is metered (in-memory daily counter, default cap 450 under the free tier's 500) and a 429 is never retried (research §18).

**Scale/Scope**: At most 100 candidate tabs per run; per user a handful of runs a day. Six new routes plus `GET /api/overview`; two existing 003 routes gain placement bookkeeping.

## Constitution Check

*GATE: Must pass before Phase 0. Re-check after Phase 1.*

| Principle | Status | How this plan complies |
| --- | --- | --- |
| I. Workspace-First | PASS | Output is workspaces (created or reused); they persist independent of tabs. Undo archives, never deletes. |
| II. Extension observes; server decides | PASS | All grouping decisions run on the server. The extension is untouched; it only supplies tab signals through the existing ingest feed. Applying moves in Chrome stays a later extension feature. |
| III. User corrections win | PASS | `placement_source` makes a user placement final for every later run; low confidence only suggests; every run is undoable; dismissals, undos, and user moves of AI placements are recorded as signals (`corrections`, run/suggestion status). |
| IV. Least-power actions | PASS | One structured LLM call per run. No agents, tools, MCP, or computer use. |
| V. One TypeScript surface | PASS | New shared types live in `@ai-browser/shared`; the web app maps rows to them; no local redefinition. |
| VI. Demo-hard, architecture-soft | PASS | Gemini is preferred but sits behind `ClusterModel`; a dead provider returns a clear error and leaves the manual workflow (003) untouched. No embeddings, no second store. |
| VII. Two surfaces | PASS | No UI. `GET /api/overview` and `placementSource` on `TabRef` give Home and the sidebar what they need. |
| Stack / secrets | PASS | Gemini per the stack table; key only in server `.env` (gitignored); no new vendor. |
| Persistence: user-scoped rows | PASS with note | All new rows carry `user_id` with composite foreign keys, except the member-id array on `suggestions` (see Complexity Tracking). |

**Gate result: PASS** (before and after Phase 1 design).

**Stack pivot (2026-09-19, user decision; constitution "Pivot rule").** The stack table lists Gemini as the preferred AI vendor. Its free tier (15 requests a minute, 500 a day, shared with a teammate and demo viewers) made it a bottleneck, so the **default provider is now the VT ARC LLM API** (OpenAI-compatible, on-premises) with **Gemini kept as the selectable backup** (`LLM_PROVIDER=gemini`). Exactly one provider is active per deployment (no dual-running). Shared types and the HTTP contract are unchanged, so the swap is config plus one module. Costs and constraints: the VT endpoint is reachable only on the VT VPN, needs a personal VT key, and enforces concurrency by rejection (research section 19).

## Project Structure

### Documentation (this feature)

```text
specs/004-ai-clustering/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── http.md
│   ├── model.md
│   └── shared-clustering-types.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks, not created here
```

### Source Code (repository root)

```text
packages/shared/
├── sql/004_clustering.sql              # NEW: tab_refs.placement_source, cluster_runs, cluster_run_moves, suggestions
└── src/
    ├── domain.ts                       # CHANGE: PlacementSource; TabRef.placementSource
    ├── clustering.ts                   # NEW: ClusterRun, Suggestion, SuggestionView, AppliedGroup, statuses
    └── index.ts                        # CHANGE: export clustering

apps/web/
├── app/api/
│   ├── cluster/runs/route.ts           # NEW: POST run, GET list
│   ├── cluster/runs/[id]/route.ts      # NEW: GET one
│   ├── cluster/runs/[id]/undo/route.ts # NEW: POST undo
│   ├── suggestions/route.ts            # NEW: GET list
│   ├── suggestions/[id]/accept/route.ts# NEW
│   ├── suggestions/[id]/ignore/route.ts# NEW
│   ├── overview/route.ts               # NEW: Home read
│   └── tab-refs/route.ts, tab-refs/[id]/route.ts   # CHANGE: set placement_source='user', write correction
├── src/
│   ├── map.ts                          # CHANGE: placement_source; cluster/suggestion mappers
│   ├── llm/                            # NEW: shared by every AI feature (004, 008–011)
│   │   ├── errors.ts                   # ModelError, ModelUnconfiguredError, BudgetExceededError
│   │   ├── budget.ts                   # in-memory daily call counter (research §18)
│   │   ├── types.ts                    # GenerateJsonOptions, Provider, deadline, wait
│   │   ├── limiter.ts                  # local per-model-family concurrency limiter
│   │   ├── index.ts                    # picks the provider (LLM_PROVIDER); the entry point features call
│   │   ├── openai-compat.ts            # VT ARC LLM API (default): OpenAI-compatible
│   │   └── gemini.ts                   # Gemini (backup); translates the canonical schema
│   └── cluster/
│       ├── model.ts                    # ClusterModel interface, getModel(), test seam (built on ../llm)
│       ├── prompt.ts                   # request building (caps, URL stripping, short ids) + answer validation
│       ├── fingerprint.ts              # candidate/workspace fingerprint, Jaccard
│       ├── run.ts                      # orchestration: guard, read, skip, ask, apply, settle, fail
│       ├── apply.ts                    # in-transaction apply with savepoints per group
│       ├── target.ts                   # resolve a group's target workspace (existing id, name match, or create)
│       ├── undo.ts                     # revert a run
│       └── suggestions.ts              # list, accept, ignore, withdraw
├── scripts/
│   ├── apply-sql.mjs                   # NEW: run a .sql file against DATABASE_URL (no psql needed)
│   ├── score-lib.mjs                   # NEW: the one SC-001 scoring function
│   └── score-clusters.mjs              # NEW: CLI that prints the SC-001 score for a token
└── tests/
    ├── global-setup.ts                 # CHANGE: also apply 004_clustering.sql
    ├── cluster-prompt.test.ts          # NEW: caps, URL stripping, validation rules
    ├── cluster.test.ts                 # NEW: apply, suggest, existing-workspace, undo, races, repeat, isolation, failures
    ├── cluster-helpers.ts              # NEW: fake model, seeding helpers
    ├── cluster-live.test.ts            # NEW: opt-in (CLUSTER_LIVE=1) real-provider score of the fixture, on PGlite
    ├── llm.test.ts, llm-vt.test.ts, llm-limiter.test.ts, llm-dispatch.test.ts   # NEW: budget, both providers, limiter, provider choice, schema translation
    ├── existing-routes.test.ts         # CHANGE: placementSource cases
    └── fixtures/mixed-tabs.batch.json, mixed-tabs-50.batch.json, mixed-tabs.labels.json   # NEW: 30-tab set (with an ambiguous group), 50-tab timing set, answer key

.env.example                            # CHANGE: LLM_PROVIDER, VT_LLM_API_KEY, LLM_MODEL*, LLM_CONCURRENCY, GEMINI_*, CLUSTER_CONFIDENCE_BAR, LLM_DAILY_CAP
specs/003-workspace-persistence-api/contracts/http.md   # CHANGE: note placementSource and the write-side effect
```

**Structure Decision**: Everything stays inside `apps/web` and `packages/shared`; no new package and no extension change. Vendor code is isolated in the provider files under `llm/` (`openai-compat.ts`, `gemini.ts`) so a pivot is one file plus config. Pure logic (`prompt.ts`, `fingerprint.ts`) is separate from database code so it is testable without Postgres.

## Cross-feature changes (flagged)

This feature edits files owned by earlier features. All changes are additive and none alters an existing response except adding one field:

| Where | Change | Why |
| --- | --- | --- |
| `packages/shared/src/domain.ts` (001) | `TabRef.placementSource`, `PlacementSource` | Constitution V: the canonical type lives in shared. Wire types for 002 derive with `Pick` and do not change. |
| `apps/web/app/api/tab-refs/**` (003) | Placement writes set `'user'` and log a correction when overriding an AI placement | Needed so user placements are recognized as final (FR-009, FR-011). |
| `specs/003-…/contracts/http.md` (003) | Document the added field and side effect | Keep the 003 contract truthful. |
| Existing database | Migration adds a column and three tables, and backfills `placement_source = 'user'` for tabs already in a workspace | The column has to exist for any run; the backfill is a one-time statement. Applying it to Tiger is an explicit quickstart step. |

## Complexity Tracking

| Deviation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| `suggestions.tab_ref_ids UUID[]` has no per-element foreign key, so it does not follow 001's composite-FK integrity rule | A suggestion is an immutable list of member ids; every read joins `tab_refs` on `(id, user_id)` so a foreign or missing id can never surface | A `suggestion_tabs` join table adds a fourth new table and more writes for a list that is never edited; revisit if suggestions ever become editable |
| `created_workspace_ids UUID[]` on `cluster_runs` (same reason) | Undo needs the workspaces a run created | Same as above |
| Migration mutates existing data (one backfill statement) | Tabs already in a workspace were all placed by hand before this feature. Clustering would skip them anyway (they are not in Other), but without the backfill their `placementSource` reads `null` ("never placed"), which the sidebar would show wrongly | Leaving them `null` is harmless for clustering but makes the read side lie; the statement only touches rows that have a workspace and no origin, and is safe to re-run |

## Risks

- **Model self-confidence is uncalibrated.** Mitigation: a bar of 0.7 (chosen from live results, see research section 5), the live fixture score (SC-001) and suggestion-vs-apply counts tune it; the bar is env-overridable.
- **The free quota is small and shared** (about 500 requests a day per model, one key for the developer, a teammate, and demo viewers). Mitigation: user-initiated calls only, one request per action, skip-if-unchanged, an in-memory daily meter, never retrying 429, and separate model ids per purpose (research §18).
- **The default provider needs the VT VPN.** Off it every call fails with a clear message and changes nothing. Mitigation: `LLM_PROVIDER=gemini` is a one-line switch back; test from the network you will demo on; a hosted deployment cannot reach it.
- **Concurrency is enforced by rejection** (10 per model, measured). Mitigation: a local limiter with headroom, and a retry with backoff on the 400 "concurrent session limit reached".
- **The VT service is for VT people with a personal key**, and logs interactions. A teammate needs their own key or Gemini.
- **Model ids are retired quickly** (`gemini-2.5-flash` already 404s for new users). Mitigation: pinned default that was called successfully, a clear 404 error naming the id, env override.
- **Latency at 50–100 tabs is unmeasured.** Mitigation: minimal thinking, 25 s timeout, quickstart V9; lower the per-run cap if needed.
- **Snippets can hold sensitive text.** Same known limitation as 002 (no per-site exclusion list); URLs are stripped of query strings and snippets are cut to 600 characters before leaving the server.
- **Undo then a later run may regroup the same tabs** when new tabs arrive. Documented in research §8; remembering undone groups is learning-from-corrections, out of scope.

## Next

`/speckit-tasks`, then `/speckit-analyze`, then `/speckit-implement`.
