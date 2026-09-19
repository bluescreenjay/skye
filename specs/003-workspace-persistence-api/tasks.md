---
description: "Task list for 003 Workspace Persistence API"
---

# Tasks: Workspace Persistence API

**Input**: Design documents from `/specs/003-workspace-persistence-api/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/http.md, quickstart.md

**Tests**: Not requested. Validate with `pnpm --filter @ai-browser/web typecheck` and curls in `quickstart.md`.

**Organization**: Stories use spec.md numbers (US1–US5). US5 (pairing) is implemented first because every other route needs a user.

## Format: `[ID] [P?] [Story] Description`

Paths are under `apps/web/` unless noted.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dependencies and env for the API

- [x] T001 Add `pg` and `@types/pg` to `apps/web/package.json` and run `pnpm install`
- [x] T002 Confirm `.env.example` contains `DATABASE_URL` and `DEVICE_TOKEN_SECRET`; add them if missing
- [x] T003 Document applying `packages/shared/sql/001_init.sql` in `apps/web/README.md` (manual `psql`, ignore already-exists)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: DB pool, token hashing, row mapping. MUST complete before story routes.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 Create `apps/web/src/db.ts` with a `pg` Pool from `process.env.DATABASE_URL` and a `query` helper using parameterized SQL only
- [x] T005 Create `apps/web/src/auth.ts` with `hashDeviceToken(token)` using SHA-256 of `DEVICE_TOKEN_SECRET + ":" + token` (hex) and `requireUser(request)` that reads `Authorization: Bearer`, looks up `users.device_token_hash`, and returns 401 JSON `{ error }` when missing/invalid — do not persist the raw token
- [x] T006 Create `apps/web/src/map.ts` mapping snake_case rows to `@ai-browser/shared` `User`, `Workspace`, `TabRef`, and `TabEvent`
- [x] T007 Create `apps/web/src/json.ts` helpers for `401`/`400`/`404` `{ error: string }` responses used by all routes

**Checkpoint**: Foundation ready — routes can call `requireUser` and `query`

---

## Phase 3: User Story 5 - Home and Sidebar share one user via pairing (Priority: P1)

**Goal**: Same device token → same `userId`; unknown token → 401 on later routes; raw token never stored.

**Independent Test**: `POST /api/session` with `T1` and `T3` returns two different `userId`s. Repeat `T1` returns the same id. `GET /api/workspaces` without Bearer is 401.

### Implementation for User Story 5

- [x] T008 [US5] Implement `POST` in `apps/web/app/api/session/route.ts`: body `{ deviceToken }`, hash, `SELECT`/`INSERT` `users`, return `{ userId }` per `specs/003-workspace-persistence-api/contracts/http.md`
- [x] T009 [US5] Reject empty/short `deviceToken` with 400 in `apps/web/app/api/session/route.ts`
- [x] T010 [US5] Verify unpaired `GET /api/workspaces` (after T012 exists, or a temporary 401 stub) never returns another user’s rows — until T012, at least session+hash insert can be checked via SQL that `device_token_hash` is not the raw token

**Checkpoint**: Pairing creates/loads a user. Token is hashed in `users`.

---

## Phase 4: User Story 1 - Workspaces survive closing the browser (Priority: P1) 🎯 MVP

**Goal**: Create, list (hide archived), get, rename, archive — user-scoped, durable after server restart.

**Independent Test**: Create two workspaces with Bearer `T1`, rename one, archive one. Restart `next dev`. List with `T1` still has the active/renamed workspace; archived omitted unless `includeArchived=true`. `T3` list does not include `T1` workspaces.

### Implementation for User Story 1

- [x] T011 [US1] Implement `GET` and `POST` in `apps/web/app/api/workspaces/route.ts` (`GET` default `status <> 'archived'`, `includeArchived=true` optional; `POST` `{ name, emoji? }`, `user_id` from `requireUser`, 400 if name empty or length not 1–80)
- [x] T012 [US1] Implement `GET` and `PATCH` in `apps/web/app/api/workspaces/[id]/route.ts` (404 if not this user’s id; PATCH `name` / `emoji` / `status` `active|archived`; bump `updated_at`)
- [x] T013 [US1] Ensure `user_id` in SQL always comes from auth, never from the JSON body, in `apps/web/app/api/workspaces/route.ts` and `apps/web/app/api/workspaces/[id]/route.ts`

**Checkpoint**: US1 curl path in `quickstart.md` (create/list/restart/isolation) works.

---

## Phase 5: User Story 2 - Tabs belong to a workspace or to Other (Priority: P1)

**Goal**: Upsert tab refs; assign to a workspace or Other (`workspace_id` null); moves persist.

**Independent Test**: Assign two tabs to a workspace and one to Other. Restart. Memberships unchanged. PATCH one tab to Other; it leaves the workspace. Empty workspace still lists (US1).

### Implementation for User Story 2

- [x] T014 [US2] Implement `GET` and `PUT` in `apps/web/app/api/tab-refs/route.ts` per `contracts/http.md` (GET filter `workspaceId` or `other=true`; PUT upsert by this user’s `chrome_tab_id` when present, else insert; `workspaceId: null` = Other)
- [x] T015 [US2] On PUT/PATCH, reject `workspaceId` that is not this user’s workspace with 400/404 in `apps/web/app/api/tab-refs/route.ts` and `apps/web/app/api/tab-refs/[id]/route.ts`
- [x] T016 [US2] Implement `PATCH` in `apps/web/app/api/tab-refs/[id]/route.ts` to move membership (`workspaceId` uuid or null) and optional title/snippet; 404 if tab is not this user’s

**Checkpoint**: Tab membership survives restart; Other is null workspace.

---

## Phase 6: User Story 3 - Sidebar can ask which workspace this tab is in (Priority: P1)

**Goal**: `GET /api/resolve` returns workspace or Other without 404 for unassigned.

**Independent Test**: Tab in workspace A with `chromeTabId=1` resolves to A. Other tab resolves `workspace: null`. Unknown id/url returns 200 with nulls. Other user’s tab id does not resolve to A.

### Implementation for User Story 3

- [x] T017 [US3] Implement `GET` in `apps/web/app/api/resolve/route.ts`: require `chromeTabId` and/or `url`; match `chrome_tab_id` first, else latest `url` for this user (`ORDER BY last_seen_at DESC LIMIT 1`); 400 if neither query param
- [x] T018 [US3] Return `{ workspace, tabRef }` with nulls and HTTP 200 when unassigned in `apps/web/app/api/resolve/route.ts` (never 404 for miss)

**Checkpoint**: Resolve matches Home’s workspace id for the same user.

---

## Phase 7: User Story 4 - Tab changes are recorded over time (Priority: P2)

**Goal**: Append-only `tab_events` as a **normal table** (no `create_hypertable`). List newest-first for this user.

**Independent Test**: POST a `reassigned` event; GET lists it after restart. `T3` does not see `T1` events.

### Implementation for User Story 4

- [x] T019 [US4] Implement `POST` in `apps/web/app/api/tab-events/route.ts` validating `eventType` against shared `TabEventType`; server sets `id`, `user_id`, `time` (now if omitted)
- [x] T020 [US4] Implement `GET` in `apps/web/app/api/tab-events/route.ts` (`limit` default 50, max 200, `ORDER BY time DESC`, this `user_id` only)
- [x] T021 [US4] Confirm no Timescale/`create_hypertable` call exists in `apps/web/` (plain INSERT/SELECT only)

**Checkpoint**: Events persist; P1 stories still work without Tiger.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Quickstart, no UI leak, typecheck

- [x] T022 Add a one-line note on `apps/web/app/page.tsx` that the product Home is not this page (API-only for 003)
- [x] T023 [P] Optionally set CORS `Access-Control-Allow-Headers: Authorization` on API responses in a small helper used by routes (needed later by 002; skip complex origin lists)
- [x] T024 Run `pnpm --filter @ai-browser/web typecheck` and fix errors
- [x] T025 Walk `specs/003-workspace-persistence-api/quickstart.md` curls (pair, workspaces, tabs, resolve, events, isolation)
- [x] T026 Confirm no Home new-tab UI, Side Panel, or clustering code was added under `apps/web/app/api/` or `apps/extension/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all stories
- **US5 (Phase 3)**: Depends on Phase 2 — pairing
- **US1 (Phase 4)**: Depends on US5 (Bearer user)
- **US2 (Phase 5)**: Depends on US1 (workspace ids to assign)
- **US3 (Phase 6)**: Depends on US2 (rows to resolve)
- **US4 (Phase 7)**: Depends on US5; can run after US2 (optional `tabRefId`)
- **Polish**: After desired stories (P1 = through US3)

### User Story Dependencies

- **US5 (P1)**: After Foundational
- **US1 (P1)**: After US5 — **MVP**
- **US2 (P1)**: After US1
- **US3 (P1)**: After US2
- **US4 (P2)**: After US5; better after US2

### Parallel Opportunities

- T004, T006, T007 after T001 (different files); T005 needs T004 for lookup
- T023 during polish while T022 is written
- US4 can be a second person after US5 if they don’t need real `tabRefId`

### Within Each Story

- Auth before writes
- List/create before get/patch
- Upsert before resolve

---

## Parallel Example: Foundational

```bash
Task: "Create apps/web/src/db.ts"
Task: "Create apps/web/src/map.ts"
Task: "Create apps/web/src/json.ts"
# Then:
Task: "Create apps/web/src/auth.ts"  # uses db
```

---

## Implementation Strategy

### MVP First (US5 + US1)

1. Phase 1–2
2. US5 session
3. US1 workspaces
4. **STOP**: two tokens, create/list, restart, isolation

### Incremental Delivery

1. US2 tab membership
2. US3 resolve (sidebar contract)
3. US4 events (no hypertables)
4. Polish / quickstart.md

---

## Notes

- Do not call `create_hypertable`
- Do not build Home or Side Panel
- Do not take `userId` from the client body
- Feature 002 is not required; curl is the client
