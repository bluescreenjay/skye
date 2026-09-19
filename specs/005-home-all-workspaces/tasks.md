---
description: "Task list for 005 Home — all workspaces"
---

# Tasks: Home — all workspaces

**Input**: Design documents from `/specs/005-home-all-workspaces/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/home-ui.md, contracts/extension-home.md, quickstart.md

**Tests**: Spec does not require Playwright. Plan asks for Vitest on grouping/membership and “no dummy seed.” Validate UI with `quickstart.md` against the mock. Typecheck: `pnpm --filter @ai-browser/extension typecheck`.

**Organization**: Stories follow spec.md (US1–US4). US1 is MVP (toolbar Home + real directory). Visual source of truth: `specs/005-home-all-workspaces/mocks/home-design-prototype/` (Home view only).

## Format: `[ID] [P?] [Story] Description`

Paths are under `apps/extension/` unless noted.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: React Home page, mock CSS, extension HTML entry

- [X] T001 Add `react`, `react-dom`, and matching `@types/react` / `@types/react-dom` to `apps/extension/package.json` and run `pnpm install`
- [X] T002 [P] Copy Home stylesheet and `main_background.jpg` from `specs/005-home-all-workspaces/mocks/home-design-prototype/` into `apps/extension/src/home/home.css` and `apps/extension/public/home/main_background.jpg` (or equivalent CRXJS-static path); strip workspace-view rules that style `#panel` / `#page` if they would leak
- [X] T003 Create `apps/extension/home.html` and `apps/extension/src/home/main.tsx` that mount a Home-only React tree (`data-view="home"`), import `home.css`, and never render the mock workspace panel/page
- [X] T004 Wire `home.html` into the CRXJS/Vite build in `apps/extension/vite.config.ts` and `apps/extension/manifest.config.ts`: keep `action` with **no** `default_popup`; confirm **no** `chrome_url_overrides` and **no** `side_panel`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: API client, view-model, weather, icons, toolbar open. MUST complete before story UI.

**⚠️ CRITICAL**: No user story UI work until this phase is complete

- [X] T005 Create `apps/extension/src/home/compose.ts` that takes `Workspace[]` + `TabRef[]` and returns `{ other: TabRef[]; cards: { workspace: Workspace; tabs: TabRef[] }[] }` (omit `archived`; Other = `workspaceId == null`; empty workspaces still get a card)
- [X] T006 [P] Create `apps/extension/src/home/api.ts` using `loadConfig` from `apps/extension/src/config.ts`: `GET /api/workspaces`, `GET /api/tab-refs`, `PATCH /api/workspaces/:id`, `PATCH /api/tab-refs/:id` with Bearer token; on 401/network return empty lists (do not throw into a different layout); never log the token
- [X] T007 [P] Create `apps/extension/src/home/weather.ts`: after first paint, geolocation (timeout ~4s) + Open-Meteo; map codes to short lowercase phrases like the mock; fallback `"hard to tell"`
- [X] T008 [P] Create `apps/extension/src/home/icons.ts` colored letter marks from hostname/title (restrained palette); do not require missing `icons/*.png`
- [X] T009 Update `apps/extension/src/background.ts` so `chrome.action.onClicked` opens `chrome.runtime.getURL("home.html")` in a new tab; keep 002 badge behavior
- [X] T010 [P] Add `apps/extension/tests/home-compose.test.ts` covering Other vs cards, empty workspace still listed, and that compose never injects dummy names like `refs — furniture`

**Checkpoint**: Toolbar can open a blank Home shell; helpers exist for data/weather/icons

---

## Phase 3: User Story 1 - Land on a map of my work (Priority: P1) 🎯 MVP

**Goal**: Toolbar opens Home. New tab stays Chrome default. Real workspaces as cards + rail tiles; Other as rail-top icons; photo, wordmark, url field, greeting; main scrolls, rail fixed. Empty/unpaired = same chrome, no dummy seed.

**Independent Test**: Load unpacked build. Cmd/Ctrl+T is not Home. Toolbar icon opens Home matching the mock’s Home structure. Seeded 003 data appears; bad token shows empty chrome without furniture dummy cards.

### Implementation for User Story 1

- [X] T011 [US1] Implement collapsed Home layout in `apps/extension/src/home/Home.tsx`: rail (Other icons, divider, workspace tiles), wordmark `skye`, url bar placeholder `url bar`, greeting line (time + weather + work hint from T007), stacked collapsed cards (name + fitting icons) using mock class names from `home.css`
- [X] T012 [US1] Load directory on mount in `apps/extension/src/home/Home.tsx` via T005/T006; lowercase copy; do not render a create-workspace control
- [X] T013 [US1] Confirm `apps/extension/manifest.config.ts` has no `chrome_url_overrides` so a normal new tab stays the browser default (quickstart check 1)

**Checkpoint**: US1 curl-less demo: toolbar Home shows real (or empty) directory in mock chrome

---

## Phase 4: User Story 2 - Peek inside a workspace without leaving Home (Priority: P1)

**Goal**: Accordion cards. Expanded = header + three columns (tabs | stub actions + ask | artifacts). Stubs allowed. Empty artifacts: `no artifacts yet`.

**Independent Test**: Expand one card → three columns. Expand another → first collapses. Collapse via header click. Actions/ask need not call an LLM.

### Implementation for User Story 2

- [X] T014 [US2] Add accordion state (`expandedId`) in `apps/extension/src/home/Home.tsx`: click card body (not name/icon) expands; only one open; click header again collapses
- [X] T015 [US2] Render expanded `card-thirds` in `apps/extension/src/home/Home.tsx` per `contracts/home-ui.md`: tab rows, stub buttons `summarize` / `collect refs` / `new artifact`, ask placeholder `ask the workspace anything`, artifacts empty line `no artifacts yet`

**Checkpoint**: Overview-on-Home works without leaving Home or opening Side Panel

---

## Phase 5: User Story 3 - Recognize Other vs named work (Priority: P1)

**Goal**: Other is rail-top icons only, never a named “other” card. Named workspaces always have a card even with zero tabs.

**Independent Test**: Mixed membership: Other only on rail; empty named workspace still a card.

### Implementation for User Story 3

- [X] T016 [US3] Guard `apps/extension/src/home/compose.ts` and `Home.tsx` so Other tab refs never appear as a workspace card titled `other` / `ungrouped tabs`
- [X] T017 [US3] Keep zero-tab workspaces as cards (empty icon row / empty tab column) in `apps/extension/src/home/Home.tsx`

**Checkpoint**: Other vs named matches spec US3

---

## Phase 6: User Story 4 - Rename and rearrange on Home (Priority: P2)

**Goal**: Inline rename persists. Drag between cards, rail tiles, and Other persists. Click opens URL in a new browser tab; Home stays. Drag does not also click-open. No create control.

**Independent Test**: Rename + reload. Drag to Other + reload. Click opens the page in another tab; Home tab still Home.

### Implementation for User Story 4

- [X] T018 [US4] Inline rename on card name in `apps/extension/src/home/Home.tsx` → `PATCH` via `apps/extension/src/home/api.ts`; persist lowercase; Enter/blur; 1–80 chars
- [X] T019 [US4] Drag-and-drop tab marks/rows between card, rail tile, and ungrouped rail in `apps/extension/src/home/Home.tsx` → `PATCH` `{ workspaceId }`; ignore the click that follows a drag
- [X] T020 [US4] On tab icon/row click, `chrome.tabs.create({ url })` from `apps/extension/src/home/Home.tsx`; do not switch Home to the mock workspace/page view
- [X] T021 [P] [US4] Add `apps/extension/tests/home-membership.test.ts` for compose after a move (workspace → Other and back) without dummy seed data

**Checkpoint**: US4 curl path in quickstart (rename, drag, click-open) works

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Typecheck, mock fidelity, no leaks

- [X] T022 Run `pnpm --filter @ai-browser/extension typecheck` and fix errors
- [X] T023 [P] Update `apps/extension/README.md` with toolbar Home, `.env`, build/load unpacked, pointer to `specs/005-home-all-workspaces/quickstart.md`; state new tab is not overridden
- [X] T024 Confirm no Side Panel, no `chrome_url_overrides`, no dummy workspace seed, and no create-workspace control under `apps/extension/src/home/` and `manifest.config.ts`
- [X] T025 Walk `specs/005-home-all-workspaces/quickstart.md` (toolbar vs new tab, layout vs mock, empty/401, location fallback)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS stories
- **US1 (Phase 3)**: Depends on Phase 2 — MVP
- **US2 (Phase 4)**: Depends on US1 (cards exist to expand)
- **US3 (Phase 5)**: Depends on US1 (same compose/Home; tighten Other vs named)
- **US4 (Phase 6)**: Depends on US1 (cards/rail to rename/drag/click)
- **Polish**: After desired stories (P1 = through US3)

### User Story Dependencies

- **US1 (P1)**: After Foundational — **MVP**
- **US2 (P1)**: After US1
- **US3 (P1)**: After US1 (can overlap US2 on `Home.tsx` — do not parallel on that file)
- **US4 (P2)**: After US1

### Parallel Opportunities

- T002 with T001 after packages exist
- T006, T007, T008 after T005 (different files)
- T010 / T021 while UI is written
- T023 during polish beside T022

### Within Each Story

- Compose/API before paint
- Collapsed Home before accordion
- Accordion before drag/rename if they share `Home.tsx` (same file → sequential)

---

## Parallel Example: Foundational

```bash
Task: "Create apps/extension/src/home/api.ts"
Task: "Create apps/extension/src/home/weather.ts"
Task: "Create apps/extension/src/home/icons.ts"
# After compose.ts:
Task: "Add apps/extension/tests/home-compose.test.ts"
```

---

## Implementation Strategy

### MVP First (US1)

1. Phase 1–2
2. US1 toolbar Home + real/empty directory
3. **STOP**: new tab unchanged; layout vs mock; no dummy seed

### Incremental Delivery

1. US2 accordion overview
2. US3 Other vs named guards
3. US4 rename, drag, click-open
4. Polish / quickstart.md

---

## Notes

- Do not add `chrome_url_overrides`
- Do not build Side Panel / mock workspace view
- Do not POST create workspace from Home
- Do not seed mock dummy workspaces
- Do not rewrite Home in Tailwind
- Feature 004 clustering is optional; curl-seeded 003 data is enough
