# Tasks: Chrome Sidebar — In-Tab Workspace

**Input**: Design documents in specs/006-chrome-sidebar-in-tab-workspace/

**Prerequisites**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/sidebar.md](contracts/sidebar.md)

**Tests**: Focused Vitest checks cover active-page mapping and out-of-order responses. Chrome validation follows [quickstart.md](quickstart.md).

**Organization**: Each user story is a usable increment. All persistent assignments remain in the existing 003 API.

## Format: Task ID, parallel marker, story label, path

- **[P]** means separate files with no unfinished dependency.
- **[US1]**, **[US2]**, **[US3]** identify the spec's user stories.

## Phase 1: Setup

**Purpose**: Add a distinct Side Panel entry without changing the Home toolbar action.

- [X] T001 [P] Add the sidePanel permission and default sidepanel.html path in apps/extension/manifest.config.ts; keep chrome.action configured for Home.
- [X] T002 [P] Create the Side Panel HTML entry with a root element in apps/extension/sidepanel.html.
- [X] T003 [P] Add sidepanel.html as a second extension build input, retaining Home and disabled module preloads, in apps/extension/vite.config.ts.

**Checkpoint**: The extension builds a separate panel entry and Chrome lists it in the Side Panel picker.

## Phase 2: Foundational

**Purpose**: Share the existing domain/presentation vocabulary and establish read-only panel state.

- [X] T004 Extract Home's tab mark and tab-row presentation in apps/extension/src/ui/TabMark.tsx and apps/extension/src/ui/TabRow.tsx, then update apps/extension/src/home/Home.tsx to use the shared pieces without changing Home behavior.
- [X] T005 Define discriminated loading, named, Other, and unavailable panel view types using shared Workspace and TabRef in apps/extension/src/sidebar/state.ts.
- [X] T006 Create the React entry in apps/extension/src/sidebar/main.tsx and mount a minimal panel view in apps/extension/src/sidebar/Sidebar.tsx from apps/extension/sidepanel.html.

**Checkpoint**: The panel mounts; Home still opens from the toolbar and retains its existing tab display.

## Phase 3: User Story 1 — See the workspace beside my page (P1, MVP)

**Goal**: Open the sidebar on a web page and see its named workspace, saved members, and a working related-page link.

**Independent Test**: Open the panel beside an assigned page whose workspace includes a closed browser tab. The name and all saved members appear; the page remains usable.

- [X] T007 [US1] Add a focused test for named, unassigned, missing, and archived resolve responses and member-list filtering in apps/extension/tests/sidebar-api.test.ts; verify it fails before implementation.
- [X] T008 [US1] Implement authenticated read-only resolve and workspace/Other member requests in apps/extension/src/sidebar/api.ts using the existing device token and 003 endpoints.
- [X] T009 [US1] Implement active-tab eligibility and initial window/tab lookup in apps/extension/src/sidebar/context.ts, reusing apps/extension/src/filters.ts.
- [X] T010 [US1] Render the current named workspace or Other and its saved tab rows in apps/extension/src/sidebar/Sidebar.tsx; clear old rows during loading and unavailable states.
- [X] T011 [P] [US1] Style a narrow, scrollable workspace view in apps/extension/src/sidebar/sidebar.css using the workspace-panel portion of the 005 mock as reference, without embedding the mock page frame.
- [X] T011b [US1] Align the panel chrome with design_mockup (home control, wordmark, address, dock) and Home tokens; close/disable the Side Panel on the Home tab via apps/extension/src/sidepanel-gate.ts.
- [X] T012 [US1] Wire a related saved tab row to open its eligible URL in a normal browser tab in apps/extension/src/sidebar/Sidebar.tsx; keep membership unchanged.
- [ ] T013 [US1] Run the named-workspace, closed-tab, related-link, and toolbar-Home scenarios in specs/006-chrome-sidebar-in-tab-workspace/quickstart.md and record any discovered contract adjustment in specs/006-chrome-sidebar-in-tab-workspace/contracts/sidebar.md.

**Checkpoint**: User Story 1 is a usable panel without tab switching support.

## Phase 4: User Story 2 — Follow the active tab (P1)

**Goal**: Keep each panel bound to its own window and show the latest active tab's workspace or Other.

**Independent Test**: Alternate between two named workspaces and Other, switch browser windows, then switch rapidly 20 times. The panel never settles on an earlier page.

- [X] T014 [US2] Add a focused race test for stale lookup completion, active-tab URL changes, tab removal/replacement, and two-window isolation in apps/extension/tests/sidebar-context.test.ts; verify it fails before implementation.
- [X] T015 [US2] Add tab activation, active-tab URL update, removal/replacement, and relevant window-focus listeners with cleanup in apps/extension/src/sidebar/context.ts; bind every panel instance to its containing normal window.
- [X] T016 [US2] Add a generation/identity guard and request cancellation where possible in apps/extension/src/sidebar/context.ts so only the newest eligible page can commit view state.
- [X] T017 [US2] Refresh the panel from current context on those events in apps/extension/src/sidebar/Sidebar.tsx, clearing named data immediately for ineligible pages and handling unpaired/service errors without stale rows.
- [ ] T018 [US2] Validate the Other, rapid-switch, second-window, ineligible-page, and service-failure scenarios in specs/006-chrome-sidebar-in-tab-workspace/quickstart.md.

**Checkpoint**: Every panel follows the active eligible page in its own window.

## Phase 5: User Story 3 — Future tools without lost work (P2)

**Goal**: Show honest plan, suggested-action, and chat areas while preserving saved work across panel lifecycle changes.

**Independent Test**: Open, close, and reopen the panel on a named workspace. Its saved identity and members return; all three tool areas are visible and claim no live result.

- [X] T019 [P] [US3] Create reusable empty plan, suggested-action, and chat sections in apps/extension/src/sidebar/ToolPlaceholders.tsx with no live assistant requests or success claims.
- [X] T020 [US3] Place the three tool sections in apps/extension/src/sidebar/Sidebar.tsx and adapt apps/extension/src/sidebar/sidebar.css so long member lists scroll without hiding the workspace label.
- [X] T021 [US3] Re-read the current page on panel mount in apps/extension/src/sidebar/context.ts so closing/reopening or browser restart restores server-saved workspace data without client-only persistence.
- [ ] T022 [US3] Validate panel reopen, browser restart, and placeholder-copy scenarios in specs/006-chrome-sidebar-in-tab-workspace/quickstart.md.

**Checkpoint**: All three stories satisfy the spec without implementing features 007–010.

## Phase 6: Polish and cross-cutting validation

- [X] T023 [P] Update panel setup and use instructions in apps/extension/README.md, including the Chrome Side Panel picker and unchanged Home toolbar action.
- [X] T024 Run pnpm typecheck, both app test suites, and pnpm --filter @ai-browser/extension build; confirm the built manifest includes the panel page and no new backend migration in specs/006-chrome-sidebar-in-tab-workspace/quickstart.md.
- [ ] T025 Complete the full Chrome walkthrough and verify the 2-second retarget target, 20-switch race check, no mock data, and no membership writes against specs/006-chrome-sidebar-in-tab-workspace/quickstart.md.

## Dependencies and execution order

### Phase dependencies

1. Setup T001–T003 can proceed in parallel; all three are needed before a Chrome build check.
2. Foundational T004–T006 follows setup. T006 depends on T005. T004 is independent of T005 but both must finish before the final UI integration.
3. US1 requires the foundation. Its API and initial-context code precede rendering; T013 checks the completed slice.
4. US2 builds on the US1 panel and adds dynamic context; its race test precedes listener/guard implementation.
5. US3 builds on the panel shell; placeholder component T019 can proceed independently of US2 until integrated at T020.
6. Polish follows the desired stories. T023 can proceed while implementation is finishing.

### Story dependencies

- **US1**: Starts after the foundation and delivers the MVP alone.
- **US2**: Needs US1's read/view path but is independently verified by tab/window switching.
- **US3**: Needs the panel shell but is independently verified by placeholders and reopen persistence.

### Parallel examples

- **Setup**: T001, T002, and T003 touch separate manifest, HTML, and build files.
- **US1**: T011 may proceed while T008/T009 implement API and initial context; integrate at T010/T012.
- **US3**: T019 may proceed while US2 work continues; integrate in T020 after the panel state is stable.

## Implementation strategy

Complete setup and foundation, then deliver US1 as a named-workspace MVP. Validate it in Chrome before adding US2 event handling. Add US3 placeholders and persistence checks last. Keep tests focused on state transitions and API contract behavior, then rely on the quickstart for native Side Panel lifecycle and layout verification.
