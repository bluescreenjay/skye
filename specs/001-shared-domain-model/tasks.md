---
description: "Task list for 001 Shared Domain Model"
---

# Tasks: Shared Domain Model

**Input**: Design documents from `/specs/001-shared-domain-model/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Not requested in the spec. Typecheck/`tsc --noEmit` is the validation (quickstart.md). No separate unit/contract test tasks.

**Organization**: Tasks are grouped by user story so each story can be implemented and checked independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: User story label (US1–US4) on story-phase tasks only
- Include exact file paths in descriptions

## Path Conventions

Monorepo per plan.md: `apps/extension/`, `apps/web/`, `packages/shared/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Root workspace so packages can be added

- [ ] T001 Create pnpm workspace root in `pnpm-workspace.yaml` with `apps/*` and `packages/*`
- [ ] T002 Create root `package.json` with `packageManager` pnpm, `private: true`, and scripts `typecheck` (`pnpm -r typecheck`) and `build` (`pnpm -r build`)
- [ ] T003 Create `.gitignore` ignoring `node_modules/`, `dist/`, `.env`, `.env.local`, `apps/*/.env*`, and `.DS_Store`
- [ ] T004 [P] Create root `tsconfig.base.json` with `strict: true`, `moduleResolution` bundler-friendly, and `target` ES2022

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Empty `@ai-browser/shared` package that later stories fill. MUST complete before user stories.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T005 Create `packages/shared/package.json` named `@ai-browser/shared` with `main`/`types` pointing at `src/index.ts` (or `dist` after build) and scripts `typecheck` (`tsc --noEmit`) and `build`
- [ ] T006 Create `packages/shared/tsconfig.json` extending `../../tsconfig.base.json` with `rootDir` `src` and include `src/**/*`
- [ ] T007 Create placeholder `packages/shared/src/index.ts` that will re-export domain types (empty export is OK until T009)

**Checkpoint**: Foundation ready — `packages/shared` exists and is listed in the pnpm workspace

---

## Phase 3: User Story 1 - One shared meaning of a workspace (Priority: P1) 🎯 MVP

**Goal**: Single TypeScript definition of User, Workspace, TabRef, TabEvent, PlanItem, Message, ActionRun, and Correction, all user-scoped where durable.

**Independent Test**: Open `packages/shared/src/domain.ts` (and `index.ts`). All eight concepts exist once. `Workspace` is not modeled as “the open tab list.” Reviewer can find them in under 5 minutes (SC-001).

### Implementation for User Story 1

- [ ] T008 [US1] Add union types `WorkspaceStatus`, `TabEventType`, `MessageRole`, and `ActionRunStatus` in `packages/shared/src/domain.ts` matching `specs/001-shared-domain-model/data-model.md`
- [ ] T009 [US1] Add interfaces `User`, `Workspace`, `TabRef`, `TabEvent`, `PlanItem`, `Message`, `ActionRun`, and `Correction` in `packages/shared/src/domain.ts` matching `specs/001-shared-domain-model/contracts/shared-types.md` (`userId` on every durable non-User entity; `TabRef.workspaceId` nullable)
- [ ] T010 [US1] Re-export all domain types from `packages/shared/src/index.ts`
- [ ] T011 [US1] Run `pnpm --filter @ai-browser/shared typecheck` and fix until it passes

**Checkpoint**: Shared model is the single source of truth. No product UI.

---

## Phase 4: User Story 2 - Work survives closing the browser (Priority: P1)

**Goal**: SQL skeleton where a workspace is a row independent of live tabs, Other is `workspace_id NULL`, and tab activity is a time-ordered `tab_events` table (Timescale hypertable call commented for Tiger; skippable on pivot).

**Independent Test**: Read `packages/shared/sql/001_init.sql`. `workspaces` has no required live tab id. `tab_refs.workspace_id` is nullable. `tab_events` is append-oriented with `time` + `event_type`. Hypertable is optional/commented.

### Implementation for User Story 2

- [ ] T012 [US2] Copy and adapt `specs/001-shared-domain-model/contracts/001_init.sql` to `packages/shared/sql/001_init.sql` (users, workspaces, tab_refs, tab_events, plan_items, messages, action_runs, corrections)
- [ ] T013 [US2] Keep `SELECT create_hypertable('tab_events', 'time', if_not_exists => TRUE);` commented with a Tiger vs Postgres-pivot note in `packages/shared/sql/001_init.sql`
- [ ] T014 [US2] Add a one-line pointer from `packages/shared/src/index.ts` or `packages/shared/README.md` to `packages/shared/sql/001_init.sql` so the schema is findable next to the types

**Checkpoint**: Durable workspace + Other + tab events exist on disk. Do not apply migrations as a required step (003 will use the DB).

---

## Phase 5: User Story 3 - Later surfaces can be configured without leaking secrets (Priority: P2)

**Goal**: Example env for data store, Gemini, optional ElevenLabs; no real secrets committed.

**Independent Test**: Fresh clone has `.env.example` with named slots and empty values. `.gitignore` already excludes `.env`. No API keys in the file.

### Implementation for User Story 3

- [ ] T015 [US3] Create `.env.example` at repo root with `DATABASE_URL=`, `GEMINI_API_KEY=`, `ELEVENLABS_API_KEY=`, and `DEVICE_TOKEN_SECRET=` plus comments for Tiger vs Supabase and Gemini vs Claude/GPT pivots per `specs/001-shared-domain-model/contracts/env.md`
- [ ] T016 [US3] Confirm `.gitignore` (T003) lists `.env` and `.env.local`; add them if missing

**Checkpoint**: Developers know where credentials will go; git stays clean.

---

## Phase 6: User Story 4 - Empty product shells (Priority: P2)

**Goal**: `apps/extension` and `apps/web` exist as sibling apps that import `@ai-browser/shared`. No Home, Side Panel, clustering, or chat.

**Independent Test**: `pnpm -r typecheck` succeeds. Both apps import `Workspace` (or equivalent) from `@ai-browser/shared`. Chrome launch is not a product demo.

### Implementation for User Story 4

- [ ] T017 [P] [US4] Create `apps/web/package.json` (Next.js App Router, TypeScript, dependency `@ai-browser/shared: workspace:*`) and `apps/web/tsconfig.json`
- [ ] T018 [P] [US4] Create `apps/extension/package.json` (Vite + CRXJS or equivalent MV3 stub, TypeScript, dependency `@ai-browser/shared: workspace:*`) and `apps/extension/tsconfig.json`
- [ ] T019 [US4] Add Next.js placeholder `apps/web/app/page.tsx` that is **not** product Home (simple “API shell” text) and `apps/web/app/layout.tsx` as required by App Router
- [ ] T020 [US4] Add MV3 stub `apps/extension/src/background.ts` and `apps/extension/manifest.config.ts` (or `manifest.json`) with a background service worker only — no `chrome_url_overrides` newtab and no `side_panel`
- [ ] T021 [US4] Add `apps/web/src/domain-check.ts` (or import inside `apps/web/app/page.tsx`) that imports `Workspace`, `TabRef`, and `TabEvent` from `@ai-browser/shared`
- [ ] T022 [US4] Add `apps/extension/src/domain-check.ts` that imports `Workspace`, `TabRef`, and `TabEvent` from `@ai-browser/shared`
- [ ] T023 [US4] Wire workspace protocol in both app `package.json` files and run `pnpm install` then `pnpm -r typecheck` until both apps compile

**Checkpoint**: Three-part repo: extension, web, shared. No user-facing workspace UI.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Match quickstart.md and keep secrets out

- [ ] T024 Add `packages/shared/README.md` describing the eight entities and pointing at `sql/001_init.sql`
- [ ] T025 [P] Add short `apps/web/README.md` and `apps/extension/README.md` stating UI/ingest land in later features
- [ ] T026 Align root scripts with `specs/001-shared-domain-model/quickstart.md` (`pnpm install`, `pnpm -r typecheck`)
- [ ] T027 Run the quickstart validation in `specs/001-shared-domain-model/quickstart.md` and fix failures
- [ ] T028 Grep the repo to confirm no live API keys and that Home/Side Panel/clustering were not added

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Phase 2
- **US2 (Phase 4)**: Depends on Phase 2; can follow or sit beside US1 (different files: `sql/` vs `domain.ts`)
- **US3 (Phase 5)**: Depends on Phase 1 `.gitignore`; independent of US1/US2 types
- **US4 (Phase 6)**: Depends on US1 (must import shared types). Extension and web package.json files can be drafted in parallel after US1.
- **Polish (Phase 7)**: Depends on US1–US4

### User Story Dependencies

- **User Story 1 (P1)**: After Foundational. MVP increment.
- **User Story 2 (P1)**: After Foundational. SQL only; does not need apps.
- **User Story 3 (P2)**: After Setup. Independent of domain types.
- **User Story 4 (P2)**: After US1. Empty shells that consume the model.

### Within Each User Story

- Types before re-exports (US1)
- SQL file before README pointer (US2)
- Env example after gitignore (US3)
- Package.json/tsconfig before source stubs (US4)
- Typecheck last in US1 and US4

### Parallel Opportunities

- T004 with T001–T003 after `package.json` exists (or immediately if paths don’t clash)
- T017 and T018 in parallel (different apps)
- T021 and T022 in parallel after T010
- T015 can run while US1/US2 proceed (different files)
- T024 and T025 in parallel during polish

---

## Parallel Example: User Story 4

```bash
# After US1 types exist:
Task: "Create apps/web/package.json and tsconfig.json"
Task: "Create apps/extension/package.json and tsconfig.json"
# Then sequentially: placeholder page, background stub
# Then in parallel:
Task: "Import shared types in apps/web/src/domain-check.ts"
Task: "Import shared types in apps/extension/src/domain-check.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational
3. Complete Phase 3: User Story 1 (shared types)
4. **STOP and VALIDATE**: `pnpm --filter @ai-browser/shared typecheck`
5. Then US2 (schema) is the other P1; US3/US4 complete the feature done-when

### Incremental Delivery

1. Setup + Foundational → package exists
2. US1 → canonical types (MVP for this feature)
3. US2 → SQL skeleton (browser-close promise is modelable)
4. US3 → env examples
5. US4 → both apps import shared
6. Polish → quickstart.md passes

### Parallel Team Strategy

1. Together: Phase 1–2
2. After Phase 2: A does US1, B does US2, C does US3
3. After US1: A/B do US4 web vs extension

---

## Notes

- [P] = different files, no incomplete-task dependencies
- Do not implement Home, Side Panel, clustering, chat, or live Gemini/Tiger clients
- Device pairing and HTTP CRUD are feature 003
- Commit after each task or logical group if using `/speckit-git-commit`
