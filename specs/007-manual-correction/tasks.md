# Tasks: Manual Workspace Correction

**Input**: Design documents in specs/007-manual-correction/

**Prerequisites**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/corrections.md](contracts/corrections.md)

**Tests**: Focused Vitest checks for create/move helpers, group mapping, and observe-only allowlisting. Chrome validation follows [quickstart.md](quickstart.md). Existing web tests already cover `placementSource: "user"` and `corrections` rows on PATCH.

**Organization**: Each user story is a usable increment. Membership writes reuse the existing 003/004 API; this feature completes Home create, sidebar move/dismiss, and Chrome tab-group sync.

## Format: Task ID, parallel marker, story label, path

- **[P]** means separate files with no unfinished dependency.
- **[US1]**–**[US4]** identify the spec's user stories.

## Phase 1: Setup

**Purpose**: Unlock Chrome tab-group APIs without changing Home toolbar behavior.

- [X] T001 Add the `tabGroups` permission in apps/extension/manifest.config.ts; keep existing sidePanel/storage/alarms/scripting/geolocation and Home action.
- [X] T002 [P] Update apps/extension/tests/manifest.test.ts to expect `tabGroups` in permissions and to stop treating it as a forbidden permission.

**Checkpoint**: Extension manifest declares `tabGroups`; typecheck/manifest tests can be updated next.

## Phase 2: Foundational

**Purpose**: Shared write helpers and an apply-groups module so stories do not fork API or Chrome logic. Ingest remains observe-only.

**⚠️ CRITICAL**: No user story UI work depends on unfinished helpers below.

- [X] T003 Extract shared authenticated workspace/tab-ref write helpers (create workspace, rename, move tab by id) used by Home and Sidebar into apps/extension/src/corrections/api.ts, migrating callers from apps/extension/src/home/api.ts without changing request shapes.
- [X] T004 [P] Add apps/extension/src/apply-groups.ts with pure mapping helpers (workspace → open tab ids, color from workspace id) and a `reconcileWindowGroups` entry that calls `chrome.tabs.group` / `chrome.tabs.ungroup` / `chrome.tabGroups.update` for one normal window; skip ineligible/incognito/Home tabs.
- [X] T005 [P] Add focused unit tests for group mapping and Other-ungroup decisions in apps/extension/tests/apply-groups.test.ts; verify they fail before T004 completes.
- [X] T006 Update apps/extension/tests/observe-only.test.ts to allowlist `apply-groups.ts` (and keep ingest modules free of `tabGroups` / `tabs.group` / membership writes).

**Checkpoint**: Shared write + group helpers exist; ingest observe-only policy still holds.

## Phase 3: User Story 1 — Fix organization on Home (P1, MVP)

**Goal**: On Home, drag across workspaces/Other, rename, and create a workspace with at least one member; changes persist after reload.

**Independent Test**: With two named workspaces and Other tabs, drag, rename, and create on Home; reload confirms membership and names.

- [X] T007 [P] [US1] Add a focused test for create-workspace + assign-tab helper outcomes (success, empty name, unpaired) in apps/extension/tests/home-create-workspace.test.ts; verify it fails before implementation.
- [X] T008 [US1] Implement `createWorkspace` (POST /api/workspaces) in apps/extension/src/corrections/api.ts (or home/api re-export) with clear failure returns for 400/401/network.
- [X] T009 [US1] Add a restrained create-workspace control on Home in apps/extension/src/home/Home.tsx and apps/extension/src/home/home.css; on success refresh the directory and support placing a tab into the new workspace via existing move.
- [X] T010 [US1] Harden Home drag and rename error surfacing in apps/extension/src/home/Home.tsx so failed PATCH/rename leaves prior UI state and shows quiet failure copy (no false success).
- [X] T011 [US1] After successful Home membership or rename, call `reconcileWindowGroups` from apps/extension/src/apply-groups.ts for the relevant window(s) without blocking the directory UI on group failure.
- [X] T012 [US1] Run Home drag, Other round-trip, rename, and create scenarios from specs/007-manual-correction/quickstart.md and note any contract tweaks in specs/007-manual-correction/contracts/corrections.md.

**Checkpoint**: Home alone delivers durable correction MVP (create + drag + rename) with best-effort Chrome groups.

## Phase 4: User Story 2 — Move this tab from the sidebar (P1)

**Goal**: From the Side Panel, move the active eligible page among workspaces/Other and dismiss a soft suggestion without leaving the page.

**Independent Test**: On a page in A, move to B then Other from the sidebar; panel retargets; optional dismiss leaves membership unchanged.

- [X] T013 [P] [US2] Add sidebar correction API helpers (list workspaces, PATCH active tabRef, ignore suggestion) in apps/extension/src/sidebar/corrections-api.ts using the shared device token.
- [X] T014 [P] [US2] Add a focused test for destination list + move/dismiss request mapping in apps/extension/tests/sidebar-corrections.test.ts; verify it fails before wiring UI.
- [X] T015 [US2] Add active-page move UI (workspace picker + Other) in apps/extension/src/sidebar/Sidebar.tsx and styles in apps/extension/src/sidebar/sidebar.css; on success refresh panel context; on failure keep prior assignment and show quiet error.
- [X] T016 [US2] Wire suggestion dismiss (when a pending suggestion is available for the active context) to POST /api/suggestions/:id/ignore in apps/extension/src/sidebar/Sidebar.tsx without changing membership.
- [X] T017 [US2] After a successful sidebar move, invoke `reconcileWindowGroups` in apps/extension/src/apply-groups.ts for the panel's window.
- [X] T018 [US2] Validate sidebar move, Other, dismiss, and API-down failure scenarios in specs/007-manual-correction/quickstart.md.

**Checkpoint**: Sidebar corrects the active page independently of Home's create control.

## Phase 5: User Story 3 — Manual wins and the browser follows (P1)

**Goal**: User-placed tabs survive organize; open eligible tabs appear in Chrome groups titled like their workspaces.

**Independent Test**: Place tabs manually, run organize (they stay), and confirm Chrome groups match Home membership for open tabs.

- [X] T019 [US3] Confirm (and document in specs/007-manual-correction/contracts/corrections.md if needed) that apps/web clustering apply paths skip `placementSource: "user"`; add a thin regression note or extend an existing apps/web/tests/cluster*.test.ts only if a gap is found—do not reimplement clustering.
- [X] T020 [US3] Complete group reconciler edge cases in apps/extension/src/apply-groups.ts: reuse existing groups when membership unchanged, ungroup Other, ignore Home/chrome/extension URLs, stable color from workspace id.
- [X] T021 [US3] Trigger a best-effort group reconcile from apps/extension/src/background.ts after a successful directory-relevant moment (e.g. post-ingest settle or explicit message from Home/Sidebar) without moving ingest modules off observe-only.
- [X] T022 [US3] Validate “organize does not clobber” and Chrome group title/membership scenarios in specs/007-manual-correction/quickstart.md.

**Checkpoint**: Durable manual placement + visible Chrome projection for the demo.

## Phase 6: User Story 4 — Corrections leave a feedback trail (P2)

**Goal**: Moves leave `corrections` rows; dismissals leave ignored suggestions; no training pipeline.

**Independent Test**: Perform known moves/dismissals and confirm user-scoped records exist; another user sees none of them.

- [X] T023 [P] [US4] Add or extend a focused assertion that Home/Sidebar move helpers result in server correction side effects (reuse apps/web/tests coverage or a thin apps/extension test that mocks fetch and documents expected PATCH body) in apps/extension/tests/corrections-feedback.test.ts.
- [X] T024 [US4] Verify dismiss path records ignored suggestion status via existing POST ignore; do not add ML/export jobs; note feedback sources in specs/007-manual-correction/data-model.md if anything drifted.
- [X] T025 [US4] Spot-check quickstart feedback items (move → corrections; dismiss → ignored) in specs/007-manual-correction/quickstart.md.

**Checkpoint**: Feedback signals exist without a training feature.

## Phase 7: Polish and cross-cutting validation

- [X] T026 [P] Update apps/extension/README.md with create-on-Home, sidebar move/dismiss, and tab-group sync behavior (including failure honesty).
- [X] T027 Mark feature 007 status in FEATURES.md once the walkthrough passes (implemented / partial as accurate).
- [X] T028 Run `pnpm typecheck`, both app test suites, and `pnpm --filter @ai-browser/extension build`; confirm built manifest includes `tabGroups`.
- [X] T029 Complete the full Chrome walkthrough in specs/007-manual-correction/quickstart.md (drag, create, sidebar move, organize, groups, API-down).

## Dependencies and execution order

### Phase dependencies

1. Setup T001–T002 before any group sync work.
2. Foundational T003–T006 before story UI that writes or groups.
3. US1 (Home) is the MVP and can ship before sidebar moves.
4. US2 needs foundational writes + panel shell from 006; can proceed after T003.
5. US3 depends on apply-groups (T004) and benefits from US1/US2 triggers.
6. US4 is verification-heavy and can trail US1–US2.
7. Polish after desired stories.

### User story dependencies

- **US1**: After foundational; no dependency on sidebar.
- **US2**: After foundational; independently testable from Home create.
- **US3**: Needs apply-groups; uses Home/Sidebar as triggers.
- **US4**: Observes outcomes of US1–US2 writes; no new product surface required.

### Parallel examples

- **Setup**: T001 and T002 together.
- **Foundational**: T004 and T005 together; T006 after apply-groups exists.
- **US1**: T007 in parallel with T008 design; T009 after T008.
- **US2**: T013 and T014 in parallel; T015–T016 after helpers land.

## Implementation strategy

1. Unlock `tabGroups` and ship shared write + apply-groups helpers.
2. Deliver **US1 Home create + hardened drag/rename** as MVP; validate persistence.
3. Add **US2 sidebar move/dismiss**.
4. Harden **US3 Chrome groups + organize regression**.
5. Confirm **US4 feedback trail** with existing server behavior.
6. Finish README, FEATURES status, and full quickstart walkthrough.

### MVP scope

**US1 only** (plus foundational apply-groups called from Home) is enough for a first demo of durable manual correction. Sidebar move and richer group sync follow immediately after.
