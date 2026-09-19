---
description: "Task list for 002 Tab Ingestion Extension"
---

# Tasks: Tab Ingestion Extension

**Input**: Design documents from `/specs/002-tab-ingestion-extension/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: The spec does not request tests, but plan.md (research §12) makes unit tests for the pure reliability logic part of the design, because "reliable ingestion" is this feature's stated focus. Test tasks below cover only the pure modules (filters, config, store, collector, snapshot, sender, snippet, recovery) and two static guards for the observe-only and privacy rules. They are written before the code they cover and should fail first. End-to-end behavior is checked manually with `quickstart.md` against the stub receiver. No Playwright or browser automation.

**Organization**: Tasks are grouped by user story so each story can be implemented and checked independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: User story label (US1–US5) on story-phase tasks only
- Include exact file paths in descriptions

## Path Conventions

Monorepo per plan.md. Extension work is in `apps/extension/` (source in `src/`, unit tests in `tests/`, the stand-in backend in `scripts/`). Shared types are in `packages/shared/src/`. `pnpm` here means `npx -y pnpm@9` if it is not installed.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Build, test, and config plumbing for the extension

- [X] T001 Update `apps/extension/package.json`: add scripts `build` (`vite build`), `test` (`vitest run`), and `stub` (`node scripts/stub-receiver.mjs`); add devDependencies `vitest` (`^5.0.0`) and `@types/node` (`^22.0.0`). Keep `typecheck` as is.
- [X] T002 Run `pnpm install` at the repo root; confirm `pnpm-lock.yaml` updated and `pnpm -r typecheck` still passes
- [X] T003 [P] Create `apps/extension/vite.config.ts`: `defineConfig` using `crx({ manifest })` from `@crxjs/vite-plugin` with the default export of `./manifest.config`; `VITE_*` values from `apps/extension/.env` reach `src/` through `import.meta.env` automatically. Never log the token
- [X] T004 [P] Create `apps/extension/.env.example` with blank `VITE_API_BASE_URL=` and `VITE_DEVICE_TOKEN=` and comments per `specs/002-tab-ingestion-extension/contracts/extension-config.md`; add `!apps/*/.env.example` after the `apps/*/.env*` line in the root `.gitignore`, then confirm with `git check-ignore -v apps/extension/.env.example` (must print nothing) and `apps/extension/.env` (must be ignored)
- [X] T005 [P] Create `apps/extension/vitest.config.ts` (`tests/**/*.test.ts`, node environment) and `apps/extension/tests/helpers/chrome-mock.ts`: an in-memory `chrome.storage.local` (`get` by key, key list, or `null`; `set`; `remove`) plus configurable stubs for `chrome.tabs`, `chrome.windows`, `chrome.alarms`, `chrome.scripting`, and `chrome.action`, installed on `globalThis.chrome`. Update `apps/extension/tsconfig.json` so `include` also lists `tests`, `vite.config.ts`, and `vitest.config.ts`, and `types` is `["chrome", "node"]`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared ingest types, eligibility, config, the durable store, the manifest, and the stand-in receiver. MUST complete before any user story.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T006 [P] Create `packages/shared/src/ingest.ts` exactly per `specs/002-tab-ingestion-extension/contracts/shared-ingest-types.md`: `SNIPPET_MAX_LENGTH`, `IngestEventType`, `TabSnapshotInput`, `TabEventInput`, `IngestActiveTab`, `IngestBatchRequest`, `IngestBatchResponse`, all derived from `TabRef`/`TabEvent` with `Pick`
- [X] T007 Add `export * from "./ingest";` to `packages/shared/src/index.ts` and run `pnpm --filter @ai-browser/shared typecheck` (after T006)
- [X] T008 [P] Add a short "Ingest types" section to `packages/shared/README.md` listing the new exports and pointing at `specs/002-tab-ingestion-extension/contracts/ingest-api.md`
- [X] T009 [P] Write `apps/extension/tests/filters.test.ts`: `http:`/`https:` pass; `chrome://`, `chrome-extension://`, `about:`, `file:`, `view-source:`, `ftp:`, empty and undefined URLs are rejected; an incognito tab is rejected even with an `https:` URL; URLs longer than 2048 characters are clamped, not rejected
- [X] T010 [P] Write `apps/extension/tests/config.test.ts`: valid config passes; empty `VITE_API_BASE_URL` or `VITE_DEVICE_TOKEN` reports `misconfigured`; a trailing slash on the base URL is removed; a non-`http(s)` base URL is rejected
- [X] T011 [P] Write `apps/extension/tests/store.test.ts` against the chrome mock: events enqueue with increasing `seq`; a `head..head+N` range reads back in order; a range is removed only when deleted after ack; dirty snapshots keep the latest per tab id; the mirror and sync state round-trip with defaults; pruning drops events older than 24 hours oldest first, increments `droppedForAge`, and sets `needsFullSnapshot`; the 20,000-event ceiling uses the same path; multi-key writes are single `storage.local.set` calls; a second store instance over the same mock storage sees the same data (worker restart)
- [X] T012 Implement `apps/extension/src/filters.ts`: `isEligibleUrl(url)`, `isEligibleTab(tab)` (window not incognito and URL scheme `http:`/`https:`), and `clampUrl(url)` (after T009)
- [X] T013 Implement `apps/extension/src/config.ts`: read `import.meta.env.VITE_API_BASE_URL` and `VITE_DEVICE_TOKEN`, validate, trim a trailing slash, and return either a config or `misconfigured`; must not read any other environment variable; when config is missing it logs one warning, once (after T010)
- [X] T014 Implement `apps/extension/src/store.ts` per `specs/002-tab-ingestion-extension/data-model.md` (after T011, T005): `ev:<seq>` events with `meta {head, tail}`; `dirty:<chromeTabId>` plus `dirty:ids` with `firstDirtyAt`/`lastChangeAt`; the `mirror` map (each entry `{url, title, windowId, lastSeenAt}`); `state` with defaults. Include `prune(now)` (24 hours and the 20,000 ceiling) and `ackDirty(tabId, lastChangeAt)`, which removes a dirty entry only if its `lastChangeAt` still equals the value captured when the batch was built. Every logical update is one `storage.local.set`/`remove` call. Keys use the `v1:` prefix
- [X] T015 Update `apps/extension/manifest.config.ts` (a static `defineManifest({...})` default export, nothing env-dependent) to the contract in `specs/002-tab-ingestion-extension/contracts/extension-config.md`: `permissions` `["storage","alarms","scripting"]`, `host_permissions` `["http://*/*","https://*/*"]`, `incognito` `"not_allowed"`, and an `action` with only `default_title`. Keep the background service worker as is. No `tabs`, `activeTab`, `<all_urls>`, `chrome_url_overrides`, `side_panel`, `content_scripts`, or popup
- [X] T016 [P] Create `apps/extension/scripts/stub-receiver.mjs` (Node `http` only, no dependencies) implementing `contracts/ingest-api.md`: `POST /api/ingest/tabs`; `--port` (default 8787), `--token` (default `dev-token`); 401 on a missing or wrong bearer token; log a one-line summary per batch (tab count, event count, `fullSnapshot`, active tab); remember event ids and report repeats as `duplicates`; respond `{accepted, duplicates}` with 200; `--fail 500|401|slow` switches to simulate failures. For each batch it also logs the delay between every event's `time` and its receipt, plus a running 95th percentile, so SC-001 can be read straight from the stub. A header comment explains usage
- [X] T017 Checkpoint: run `pnpm -r typecheck`, `pnpm --filter @ai-browser/extension test`, and `pnpm --filter @ai-browser/extension build`; confirm `apps/extension/dist/manifest.json` exists, has a background service worker, and lists exactly the permissions from T015

**Checkpoint**: Foundation ready. Types, filters, config, durable store, manifest, and stub receiver exist and build

---

## Phase 3: User Story 1 - Every open tab and every change reaches the backend (Priority: P1) 🎯 MVP

**Goal**: The backend receives a snapshot of all open tabs on start and a timestamped event for every open, update, and close, without user action.

**Independent Test**: Run the stub receiver, load the extension, then open, navigate, and close tabs across two windows (quickstart V1, V2). The stub shows the full snapshot and one `opened`, `updated`, and `closed` event each, with unique ids.

### Tests for User Story 1 (write first; they should fail)

- [X] T018 [P] [US1] Write `apps/extension/tests/collector.test.ts` with fake timers: creation with an eligible URL emits `opened` immediately; a tab that first becomes eligible later emits `opened` at the settle flush; a burst of updates emits one `updated` about 2 seconds after the last change carrying the final state; a tab still changing after 30 seconds is flushed anyway; an update with no net URL/title change emits nothing; removal emits `closed` with the mirrored URL and title; navigating to an ineligible URL emits `closed` without that URL; moving between windows emits nothing; replacement emits `closed` for the old id and `opened` for the new id; events are queued in occurrence order with unique UUID ids
- [X] T019 [P] [US1] Write `apps/extension/tests/snapshot.test.ts`: reconciling a full tab list against the mirror emits `opened` for new eligible tabs, `closed` for mirrored tabs that are gone, and queues a snapshot for each eligible tab; a browser-start reset first closes every mirrored tab from the previous session (using its `lastSeenAt`) and clears the mirror; incognito and non-`http(s)` tabs are ignored
- [X] T020 [P] [US1] Write `apps/extension/tests/sender.test.ts` (happy path): a batch takes up to 100 events in order plus all pending snapshots; the request matches `IngestBatchRequest` (fresh `batchId`, `sentAt`, `fullSnapshot` flag); on `200` the sent range is removed and each dirty entry is removed only if unchanged since the batch was built (a change made during the request is kept); a queued event triggers a drain within about 1 second (fake timers); only one request is in flight at a time; `Authorization: Bearer <token>` is sent

### Implementation for User Story 1

- [X] T021 [US1] Implement `apps/extension/src/collector.ts` (after T018, T012, T014): a `createCollector` factory taking the store, a clock, and timer functions so tests can inject fakes. Handlers for `tabs.onCreated`, `onUpdated`, `onRemoved`, `onReplaced` (attach/detach are ignored); the 2-second settle and 30-second cap; net-change check against the mirror; persists pending state so an overdue flush survives a worker restart; a `flushDue(now)` method for the heartbeat; after every enqueue or settle flush it calls an injected `onQueued()` callback. Event ids from `crypto.randomUUID()`
- [X] T022 [US1] Implement `apps/extension/src/snapshot.ts` (after T019): `reconcile(tabs)` diffs the eligible tabs from `chrome.tabs.query({})` against the mirror (new → `opened`, gone → `closed`, changed → queued update) and queues a snapshot for every eligible tab; `resetForBrowserStart()` closes and clears every mirrored tab from the previous session before reconciling (tab ids from an earlier browser session cannot be trusted). Snippets stay empty until US3
- [X] T023 [US1] Implement `apps/extension/src/sender.ts` happy path (after T020, T013): `drainOnce()` builds the request from the store (events `head..head+99` plus dirty snapshots and the `fullSnapshot` flag), POSTs to `{apiBaseUrl}/api/ingest/tabs` with the bearer token, and on `200` deletes the sent event range and acknowledges each dirty entry with `ackDirty`, using the `lastChangeAt` captured when the batch was built. `active` is `{windowId: null, chromeTabId: null}` until US2. Failure handling is added in US4
- [X] T024 [US1] Update `apps/extension/src/background.ts` (after T021–T023): register every listener synchronously at the top level (`tabs.onCreated`, `onUpdated`, `onRemoved`, `onReplaced`; `onAttached`/`onDetached` are intentionally not handled); `runtime.onInstalled` runs a reconcile with a full snapshot; `runtime.onStartup` runs `resetForBrowserStart()` then a full snapshot; ensure a 30-second `sync` alarm exists (create only if absent) and its handler runs `flushDue` then `drainOnce`; wire the collector's `onQueued()` to schedule `drainOnce()` in-process after about 1 s of quiet (coalesced, no extra alarm), so delivery does not wait for the heartbeat; skip everything when config is `misconfigured`. Keep `background.ts` to wiring only
- [ ] T025 [US1] (manual, needs you and Chrome) First copy `apps/extension/.env.example` to `apps/extension/.env` with `VITE_API_BASE_URL=http://localhost:8787` and `VITE_DEVICE_TOKEN=dev-token`, rebuild, load `apps/extension/dist` unpacked, then validate `specs/002-tab-ingestion-extension/quickstart.md` scenarios V1 and V2 against the stub; note the results

**Checkpoint**: User Story 1 works on its own: tabs and their changes reach the stub

---

## Phase 4: User Story 2 - The active tab is always known (Priority: P1)

**Goal**: Every tab switch is an event, and every request says which tab is currently in front, including when the user moves to a page that is not reported.

**Independent Test**: Switch between tabs and windows, including onto a `chrome://` page (quickstart V3). The stub shows `activated` events and an `active` field that follows the front tab and becomes `null` for an unreported page.

### Tests for User Story 2 (write first; they should fail)

- [X] T026 [P] [US2] Write `apps/extension/tests/active.test.ts`: `onActivated` on a tracked tab emits `activated` immediately; on an untracked tab it emits nothing; `windows.onFocusChanged` to a real window emits `activated` for that window's active tracked tab; `WINDOW_ID_NONE` is ignored; closing the active tab is followed by an activation for the newly active tab; the active sample returns `{windowId, chromeTabId}` for a tracked active tab and `{windowId, chromeTabId: null}` for an untracked one, and `null` ids when no window is focused

### Implementation for User Story 2

- [X] T027 [US2] Add `onTabActivated` and `onWindowFocusChanged` handlers to `apps/extension/src/collector.ts` (after T026, T021)
- [X] T028 [US2] Add `sampleActive()` to `apps/extension/src/snapshot.ts`: uses `chrome.windows.getLastFocused` and `chrome.tabs.query` to return the `IngestActiveTab` for the focused window; also mark `active` and `windowId` on queued snapshots (after T022)
- [X] T029 [US2] Update `apps/extension/src/sender.ts` to fill the request's `active` from `sampleActive()` at build time (after T028, T023)
- [X] T030 [US2] Register `tabs.onActivated` and `windows.onFocusChanged` at the top level of `apps/extension/src/background.ts` and route them to the collector (after T027, T024)
- [ ] T031 [US2] (manual, needs you and Chrome) Validate with quickstart V3; note the results

**Checkpoint**: User Stories 1 and 2 both work: tab state, changes, and the active tab reach the stub

---

## Phase 5: User Story 3 - A short page snippet is captured where possible (Priority: P2)

**Goal**: Each reported tab carries a short plain-text excerpt when the page can be read, and an empty snippet otherwise, without ever blocking the tab.

**Independent Test**: Open an article, a `chrome://settings` page, and a nearly empty page (quickstart V4). The article has a snippet of at most 2000 characters; the empty page has `""`; the settings page never appears.

### Tests for User Story 3 (write first; they should fail)

- [X] T032 [P] [US3] Write `apps/extension/tests/snippet.test.ts`: whitespace is collapsed; the result is cut to `SNIPPET_MAX_LENGTH`; markup-looking text is returned as plain text; an `executeScript` rejection, an empty result, or a discarded tab yields `""`; capture happens only when the URL changed or no snippet exists yet, otherwise the previous snippet is reused; a failed capture never prevents the tab's snapshot or events from being queued

### Implementation for User Story 3

- [X] T033 [US3] Implement `apps/extension/src/snippet.ts` (after T032): `captureSnippet(tabId)` runs `chrome.scripting.executeScript` with a function returning `document.body?.innerText`, then collapses whitespace and truncates to `SNIPPET_MAX_LENGTH`; any error returns `""`
- [X] T034 [US3] Call `captureSnippet` from the settle flush in `apps/extension/src/collector.ts` when the tab status is `complete` and the URL changed or no snippet exists; skip discarded tabs; the snippet goes only into the dirty snapshot, never into an event (after T033, T027)
- [X] T035 [US3] In `apps/extension/src/snapshot.ts`, capture snippets during a full snapshot with at most 5 captures running at once so 100 tabs stay within the 15-second goal (after T033, T028)
- [ ] T036 [US3] (manual, needs you and Chrome) Validate with quickstart V4; note the results

**Checkpoint**: Snippets appear on normal pages and are empty, never fatal, everywhere else

---

## Phase 6: User Story 4 - Sync survives interruptions without losing or duplicating events (Priority: P2)

**Goal**: Outages, restarts, worker shutdowns, and rejected credentials never lose events, reorder them, or send duplicates a retry could not be de-duplicated for.

**Independent Test**: Stop the stub, browse, restart it (V6); quit Chrome with a backlog and reopen (V7); run the stub with `--fail 401` (V8). Every event arrives once and in order, nothing is dropped, and the badge shows `!` on auth failure.

### Tests for User Story 4 (write first; they should fail)

- [X] T037 [P] [US4] Write `apps/extension/tests/sender-retry.test.ts`: a network error, timeout, 408, 429, or 5xx keeps the backlog and sets `retrying` with a doubling delay from 2 seconds to 5 minutes with jitter, and `Retry-After` overrides it; 401/403 sets `auth_failed`, stops sending, and keeps everything; 413 halves the batch; a 400/422 bisects to one event, quarantines it (`quarantinedInvalid`), and continues; a `200` with `duplicates > 0` still acknowledges; a retried range reuses the same event ids and never reorders
- [X] T038 [P] [US4] Write `apps/extension/tests/recovery.test.ts`: after a simulated worker restart (new store and collector over the same storage) an overdue dirty tab is flushed by the heartbeat; the prune runs before batching and, when it drops events, sets `needsFullSnapshot` so the next request is `fullSnapshot: true`; `needsFullSnapshot` is also set on auth recovery and cleared only when a full request is acknowledged

### Implementation for User Story 4

- [X] T039 [US4] Extend `apps/extension/src/sender.ts` (after T037, T029): retry, backoff with jitter, `Retry-After`, the status transitions in `data-model.md`, 401/403 stop, 413 halving, 400/422 bisect and quarantine, and `needsFullSnapshot` handling. Never delete an event that was not acknowledged or explicitly quarantined
- [X] T040 [P] [US4] Create `apps/extension/src/status.ts`: `applyStatus(status)` sets the badge per `contracts/extension-config.md` (`retrying` → `…`, `auth_failed`/`misconfigured` → `!` in red, otherwise cleared) using `chrome.action`
- [X] T041 [US4] Update the heartbeat handler in `apps/extension/src/background.ts` (after T038, T039, T040): each tick runs `store.prune`, then `flushDue`, then `drainOnce` (which takes the full snapshot itself when `needsFullSnapshot` is set), then `applyStatus`. The tick lives in `apps/extension/src/heartbeat.ts` so it is testable and `background.ts` stays wiring only, together with `resetSyncState` for install and browser start. A reconcile on every worker wake was deliberately not added: Chrome delivers every tab event to a woken worker, and a full reconcile costs a storage read per tab on every wake
- [ ] T042 [US4] (manual, needs you and Chrome) Validate with quickstart V6, V7, V8, V12 and the "alarm restarts a stopped worker" check; note the results

**Checkpoint**: The event history is complete and de-duplicable through outages, restarts, and credential failures

---

## Phase 7: User Story 5 - The extension only observes (Priority: P2)

**Goal**: The extension reports and stops there: no tab is moved, grouped, renamed, or closed, nothing from incognito or internal pages is reported, and no UI beyond the badge exists.

**Independent Test**: Browse normally, including an incognito window and internal pages (quickstart V9, V10). No tab is touched and nothing from those sources reaches the stub. The static guards below pass.

### Tests for User Story 5 (write first; they should fail if the rules are broken)

- [X] T043 [P] [US5] Write `apps/extension/tests/manifest.test.ts`: import the static manifest export and assert the exact `permissions`, `host_permissions`, `incognito`, and `action`; assert none of the forbidden keys from `contracts/extension-config.md` are present (`tabs`, `activeTab`, `<all_urls>`, `chrome_url_overrides`, `side_panel`, `sidePanel`, `content_scripts`, `unlimitedStorage`, any popup or options page)
- [X] T044 [P] [US5] Write `apps/extension/tests/observe-only.test.ts`: scan every file under `apps/extension/src/` and assert it contains no call to `chrome.tabs.create`, `update`, `move`, `remove`, `group`, `duplicate`, `discard`, `chrome.tabGroups`, `chrome.windows.create`, `update`, or `remove`; also assert that no tab identity is persisted beyond `chromeTabId` and the mirror (FR-017)
- [X] T045 [P] [US5] Write `apps/extension/tests/privacy.test.ts` as the single cross-module privacy check (T009 stays the unit test of the filter): run incognito tabs and `chrome://`, `chrome-extension://`, `file:` tabs through the collector, the full snapshot, and the snippet capture; assert nothing is queued, mirrored, captured, or sent for any of them

### Implementation for User Story 5

- [X] T046 [US5] Make T043–T045 pass: adjust `apps/extension/manifest.config.ts` or the modules under `apps/extension/src/` only where a rule is actually violated; do not weaken the tests
- [ ] T047 [US5] (manual, needs you and Chrome) Validate with quickstart V9 (incognito, with "Allow in incognito" both off and on) and V10; note the results

**Checkpoint**: All five stories work, and the guards keep the extension observe-only

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, the 003 hand-off, and final verification

- [X] T048 [P] Update `apps/extension/README.md`: replace the "Vite config arrives with feature 002" note with setup (`.env`), the `build`, `test`, and `stub` scripts, how to load `dist/` unpacked, and a pointer to `specs/002-tab-ingestion-extension/quickstart.md`
- [X] T049 [P] Append the ingest hand-off to the feature 003 "Specify prompt" in `FEATURES.md`: authenticate by bearer token; match a reported tab to an existing record by user and address; refresh `chromeTabId` from every snapshot and clear it for tabs missing from a `fullSnapshot: true` request; count events once by event id; contract at `specs/002-tab-ingestion-extension/contracts/ingest-api.md`
- [ ] T050 (manual, needs you and Chrome) Run the full `specs/002-tab-ingestion-extension/quickstart.md`: V1–V12 (including V11 with 100 tabs) and the three "open questions from research" checks (alarm restarts a stopped worker; `http://*/*` covers `http://localhost:<port>`; `incognito: "not_allowed"` behavior); fix failures. If localhost is not covered, add the API origin to `host_permissions`
- [X] T051 Run `pnpm -r typecheck`, `pnpm --filter @ai-browser/extension test`, and `pnpm --filter @ai-browser/extension build`; then grep the repo for live tokens or keys and confirm `apps/extension/.env` and `apps/extension/dist/` are not tracked (`git status`, `git check-ignore`), that `apps/extension/.env.example` is tracked with blank values, and that no Home, side panel, settings page, or tab-moving behavior was added
- [ ] T052 Only after T050 and T051 pass: set the 002 row in `FEATURES.md` to `☑ done` and note that server-visible records are confirmed in feature 003; also amend 002's "Done when" line in `FEATURES.md` to match the spec (correct records reach the configurable endpoint, verified against the stub receiver)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies. T001 and T002 first; T003, T004, T005 can then run in parallel
- **Foundational (Phase 2)**: Depends on Setup and BLOCKS every user story. Tests T009–T011 before their code T012–T014; T006 → T007; T017 last
- **US1 (Phase 3)**: Depends on Phase 2. Delivers the MVP
- **US2 (Phase 4)**: Depends on US1 (extends the collector, snapshot, sender, and `background.ts`)
- **US3 (Phase 5)**: Depends on US1 and US2's file changes (collector and snapshot); independent in behavior
- **US4 (Phase 6)**: Depends on US1 and US2 (extends the sender and the heartbeat); independent in behavior from US3
- **US5 (Phase 7)**: Depends on Phase 2; its guards are easiest to run last, after US1–US4 code exists
- **Polish (Phase 8)**: Depends on all stories

### User Story Dependencies

- **US1 (P1)**: After Foundational. Standalone, delivers a working slice
- **US2 (P1)**: After US1. Adds the active-tab signal
- **US3 (P2)**: After US2 (shares `collector.ts` and `snapshot.ts`). Snippets are additive; tabs are reported without them
- **US4 (P2)**: After US2 (shares `sender.ts` and `background.ts`). Hardens delivery
- **US5 (P2)**: After Foundational for the guards; final pass after US1–US4

### Within Each Story

- Tests before the code they cover
- `collector.ts` and `snapshot.ts` before `sender.ts` changes that use them, and all before `background.ts` wiring
- Manual validation last in each story

### Parallel Opportunities

- T003, T004, T005 together after T002
- T006, T008, T009, T010, T011, T016 together (different files)
- T018, T019, T020 together (three test files)
- T037 and T038 together; T043, T044, T045 together
- T040 alongside T039 (different files)
- T048 and T049 together

---

## Parallel Example: Foundational tests

```bash
# Different files, no dependencies on each other:
Task: "Write apps/extension/tests/filters.test.ts"
Task: "Write apps/extension/tests/config.test.ts"
Task: "Write apps/extension/tests/store.test.ts"
Task: "Create apps/extension/scripts/stub-receiver.mjs"
```

---

## Implementation Strategy

### MVP First (User Story 1, then 2)

1. Complete Phase 1 (Setup) and Phase 2 (Foundational)
2. Complete Phase 3 (US1)
3. **STOP and VALIDATE** with quickstart V1 and V2: tabs and their changes reach the stub
4. Add US2 (P1) for the active-tab signal, then validate V3. That is the full P1 set

### Incremental Delivery

1. Setup + Foundational → builds, tests run, stub receives requests
2. US1 → tab state and events flow
3. US2 → active tab known
4. US3 → snippets
5. US4 → survives outages, restarts, and rejected credentials
6. US5 → guards keep it observe-only
7. Polish → docs, the 003 hand-off, full quickstart

### Scope note

"Done" here means correct records reach the configurable endpoint, verified against the stub receiver. Server-visible records in the database are confirmed after feature 003.

---

## Notes

- [P] = different files, no dependency on an incomplete task
- Do not implement Home, a Side Panel, a settings page, clustering, or any tab-moving behavior
- Never commit `apps/extension/.env`, a real device token, or `apps/extension/dist/`
- Stage files by name when committing; commits, pushes, and branch changes need the user's approval (`CLAUDE.md`)
- Do not touch the user's uncommitted deletion of the root `.env.example`
- Implementation pauses at each task marked "manual, needs you and Chrome" and hands the checklist to the user
