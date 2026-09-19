---
description: "Task list for 005b Home → run clustering"
---

# Tasks: Home → run clustering

**Input**: Design documents from `/specs/005b-home-run-clustering/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/home-organize.md, quickstart.md; shipped 004 API + 005 Home

**Tests**: Plan asks for Vitest on HTTP-outcome → UI-state mapping and “no dummy seed.” Typecheck: `pnpm --filter @ai-browser/extension typecheck`. Validate with `quickstart.md` (needs Gemini + ingested Other tabs).

**Organization**: Stories follow spec.md (US1–US3). US1 is MVP (organize + refresh). Paths under `apps/extension/` unless noted.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm 005 Home is the base; minimal CSS hook for the control

- [X] T001 Confirm `apps/extension/src/home/Home.tsx`, `api.ts`, and toolbar `home.html` from 005 exist and build; no new Vite/manifest entries required for 005b
- [X] T002 [P] Add minimal lowercase organize-control styles in `apps/extension/src/home/home.css` (restrained; do not redesign the mock Home layout)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Client call + outcome mapping. MUST complete before story UI wiring finishes.

**⚠️ CRITICAL**: No organize button behavior until `runCluster` + outcome helper exist

- [X] T003 Create `apps/extension/src/home/organize.ts` with types for organize UI status (`idle` | `running` | `failed` | `empty`) and a pure `mapClusterHttpResult(status, body)` that maps 004 responses/errors to `{ status, message }` per `contracts/home-organize.md` (success, skipped/empty, 409 in-progress, 401/503/429/502/network); never invent workspace names
- [X] T004 Add `runCluster()` to `apps/extension/src/home/api.ts`: `POST /api/cluster/runs` with Bearer from `loadConfig`, body `{}` (`force: false`); return status + parsed JSON or error shape; never log the token; do not call Gemini in the extension
- [X] T005 [P] Add `apps/extension/tests/home-organize.test.ts` covering map outcomes for applied success, skipped/empty, 409, 401/503, and that mapping never injects dummy names like `refs — furniture`

**Checkpoint**: Helpers can POST and classify results without UI

---

## Phase 3: User Story 1 - Organize from Home (Priority: P1) 🎯 MVP

**Goal**: One organize control starts a 004 run and refreshes the directory so named cards appear.

**Independent Test**: Other tabs present → click organize → in-progress → cards appear / Other shrinks; stay on Home.

### Implementation for User Story 1

- [X] T006 [US1] Add organize control (label `organize`) and in-progress state to `apps/extension/src/home/Home.tsx` near home-top/greeting; disable or ignore re-entry while `running`
- [X] T007 [US1] On click in `Home.tsx`, call `runCluster` from `api.ts`, then `loadDirectory` + `composeDirectory` on HTTP 200 so cards/rail match the server; clear running state
- [X] T008 [US1] On success with applied groups, ensure Home shows updated named workspace cards without leaving the Home tab (no Side Panel navigation)

**Checkpoint**: Happy-path demo works with fixture or ingested Other tabs

---

## Phase 4: User Story 2 - Understand failure without breaking Home (Priority: P1)

**Goal**: Failures keep Home chrome and show quiet copy; no dummy seed.

**Independent Test**: Bad token / API down / 409 → failure or “already organizing” message; rail + main intact; no furniture dummy cards.

### Implementation for User Story 2

- [X] T009 [US2] Wire `mapClusterHttpResult` failure/`empty` messages into `Home.tsx` status text for 401, network, 503/429/502, skipped/empty applied, and 409 `run_in_progress`
- [X] T010 [US2] Guard `Home.tsx` / organize path so failures never call compose with invented workspaces and never POST `/api/workspaces`

**Checkpoint**: Forced failure leaves Home usable and honest

---

## Phase 5: User Story 3 - Stay out of later features (Priority: P2)

**Goal**: Only the thin organize chrome; no suggestions inbox, Side Panel, ⌘K, or create-workspace.

**Independent Test**: Grep/review Home sources for forbidden surfaces.

### Implementation for User Story 3

- [X] T011 [US3] Confirm `apps/extension/src/home/` does not render `suggestions` accept/ignore UI, Side Panel entry, command bar, or create-workspace control; ignore `suggestions[]` from the cluster response except optionally counting nothing
- [X] T012 [P] [US3] Grep `apps/extension/src/home/` and `manifest.config.ts` for `side_panel`, `chrome_url_overrides`, `POST /api/workspaces`, and suggestion accept routes—must remain absent for this feature

**Checkpoint**: Scope matches FR-007 / SC-004

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Typecheck, docs, quickstart

- [X] T013 Run `pnpm --filter @ai-browser/extension typecheck` and fix errors
- [X] T014 [P] Update `apps/extension/README.md` with one short note: Home organize calls clustering; needs `GEMINI_API_KEY` on the API and pointer to `specs/005b-home-run-clustering/quickstart.md`
- [X] T015 Walk `specs/005b-home-run-clustering/quickstart.md` (seed Other, build/reload, organize success + one failure case)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup**: Start immediately (Home already exists)
- **Foundational**: Depends on Setup — BLOCKS story wiring
- **US1**: Depends on Foundational — MVP
- **US2**: Depends on US1 (same control; failure paths)
- **US3**: Depends on US1 (audit after control exists); can overlap US2 on different files
- **Polish**: After US1–US3 desired

### User Story Dependencies

- **US1 (P1)**: After Foundational — **MVP**
- **US2 (P1)**: After US1 (extends same `Home.tsx` status)
- **US3 (P2)**: After US1 (scope guard)

### Parallel Opportunities

- T002 with T001
- T005 while T003/T004 if signatures agreed
- T012 during polish beside T013/T014
- Do not parallelize T006–T010 on `Home.tsx`

### Parallel Example: Foundational

```bash
Task: "Create apps/extension/src/home/organize.ts"
Task: "Add runCluster to apps/extension/src/home/api.ts"
# Then:
Task: "Add apps/extension/tests/home-organize.test.ts"
```

---

## Implementation Strategy

### MVP First (US1)

1. Phase 1–2 helpers
2. Organize + refresh on success
3. **STOP**: demo Other → cards without curl for the organize step

### Incremental Delivery

1. US2 failure copy
2. US3 scope greps
3. Polish / quickstart.md

---

## Notes

- Do not reimplement clustering or call Gemini from the extension
- Do not add Side Panel, ⌘K, create-workspace, or suggestions inbox
- Do not change `apps/web` routes for 005b
- `force: false` by default per research.md
