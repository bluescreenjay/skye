# Tasks: Mobile Voice and Project Assistant

**Input**: [Feature specification](spec.md). Feature 015 does not yet have a plan, data model, or finalized HTTP contracts; Phase 1 creates those before implementation.  
**Prerequisites**: Feature 014 paired mobile chat and feature 008 workspace chat; feature 010b action registry and Notion/Gmail paths must be working for User Story 3. The existing 014 task list is not a reliable completion ledger: inspect code and tests at each gate.  
**Tests**: Vitest with fake ElevenLabs, model, Notion, and Gmail adapters; PGlite for server routes; a phone viewport walkthrough for capture and review.

## Format

- `[ ] T### [P?] [US#?]` identifies a task. `[P]` means the task can run alongside other tasks in that phase because it touches separate files and has no unfinished dependency.
- `US1` = voice questions in a workspace; `US2` = all-projects questions; `US3` = reviewed natural-language actions; `US4` = cross-device continuity.
- Every checkpoint is a usable slice. Complete the prerequisite tasks in order, then the user stories in the order shown.

## Phase 1: Plan and contracts

**Purpose**: Settle the choices the feature spec deliberately leaves open, especially browser STT transport, cross-project context limits, email identity, and aggregate action ownership.

- [ ] T001 Read `FEATURES.md`, `specs/015-mobile-voice-project-assistant/spec.md`, the 008/010b/014 contracts, `apps/mobile/src/App.tsx`, `apps/mobile/src/api.ts`, and the current action and chat routes. Record implemented vs planned dependencies in `specs/015-mobile-voice-project-assistant/research.md`.
- [ ] T002 Choose either client-side ElevenLabs Scribe realtime with a server-issued single-use token or a server-proxied short recording with Scribe batch STT. Document browser support, permission behavior, audio cap, cost/rate limit, and fallback in `research.md`; verify endpoint and token details against current official ElevenLabs docs.
- [ ] T003 Define exact cross-project retrieval budgets and ranking, coverage semantics, source IDs, history length, model deadlines, and retention/deletion rules in `specs/015-mobile-voice-project-assistant/plan.md` and `data-model.md`. Keep the existing workspace chat's one-workspace boundary.
- [ ] T004 Define a verified or explicitly entered and confirmed “email me” recipient flow, supported Notion destination, and how an aggregate answer becomes an action source without an arbitrary workspace ID. Write the decision in `plan.md`; identify any required 010b adapter changes.
- [ ] T005 Write `contracts/http.md`, `contracts/voice.md`, and `contracts/mobile-ui.md` with request/response examples, error codes, proposal states, idempotency keys, and the Gmail second-confirmation sequence. Add `quickstart.md` with a manual walkthrough and `checklists/requirements.md` mapping FR-001–FR-016 to tasks and acceptance checks. Do not start the migration until T003–T005 agree.

**Checkpoint**: A reviewer can trace every FR-001–FR-016 requirement to a contract and a later task. No endpoint relies on an unspecified identity, destination, or scope.

---

## Phase 2: Shared foundations

**Purpose**: Add types and durable state used by the all-projects and action stories.

- [ ] T006 Add shared types for project chat messages, server-resolved citations, coverage, action proposals, and proposal states in `packages/shared/src/project-assistant.ts`; export them from `packages/shared/src/index.ts`. Match the Phase 1 contracts.
- [ ] T007 Add `packages/shared/sql/015_project_assistant.sql` for person-scoped project chat and proposals, their indexes, expiry/state fields, source snapshots, and idempotency uniqueness. Include the migration in `apps/web/tests/global-setup.ts` and the production migration instructions.
- [ ] T008 [P] Add scoped row mappers and validation helpers under `apps/web/src/project-assistant/`; cap text, IDs, citation counts, and payload sizes at the API boundary. Validate ownership at every lookup.
- [ ] T009 [P] Add a test fixture helper in `apps/web/tests/project-assistant-helpers.ts` for two users, paired and revoked devices, several workspaces, summaries, plans, tabs, agent results, and fake provider seams. Reuse current test setup and avoid live services.

**Checkpoint**: Migration and shared types build; test fixtures can prove that user A cannot read or mutate user B's rows.

---

## Phase 3: User Story 1 — Voice questions in one workspace (P1)

**Goal**: A committed ElevenLabs transcript fills the editable mobile composer; Send uses the existing workspace chat route exactly once.

**Independent test**: Speak a question, edit the transcript, send it, and find the resulting text exchange in desktop workspace history. Denied permission or unavailable ElevenLabs leaves typed chat working.

### Tests

- [ ] T010 [P] [US1] Add route tests in `apps/web/tests/voice-stt.test.ts` for paired auth, revoked token, missing key, request/rate/duration caps, safe provider errors, and the absence of raw audio or transcript persistence before Send.
- [ ] T011 [P] [US1] Add mobile component tests in `apps/mobile/tests/voice-composer.test.tsx` for explicit start/stop/cancel, provisional vs committed text, edit/discard, silence, duplicate commits, permission denial, navigation cleanup, and one chat send. Add the minimal mobile Vitest setup if needed.

### Implementation

- [ ] T012 [US1] Implement the chosen STT route in `apps/web/app/api/voice/` and its ElevenLabs adapter under `apps/web/src/voice/`. Keep `ELEVENLABS_API_KEY` server-side; return only an ephemeral token or bounded transcript; add auth, limits, and configuration reporting without exposing credentials. (depends on T002, T010)
- [ ] T013 [US1] Add a reusable mobile voice controller/component under `apps/mobile/src/voice/` and styling in `apps/mobile/src/mobile.css`. Assemble only committed segments, keep provisional text separate, stop on navigation/revocation, and expose clear permission and error states. (depends on T011–T012)
- [ ] T014 [US1] Wire the voice control into the workspace composer in `apps/mobile/src/App.tsx`; send through the existing `ask` function in `apps/mobile/src/api.ts`, never through a voice-specific chat store. Update `apps/mobile/.env.example` or README with voice configuration and secure-context microphone needs. (depends on T013)
- [ ] T015 [US1] Checkpoint: run the voice route and mobile tests, `pnpm --filter @ai-browser/mobile build`, and a phone-sized workspace-chat walkthrough. Verify typed chat still works with ElevenLabs unset.

---

## Phase 4: User Story 2 — Ask across all projects (P1)

**Goal**: An authenticated, separate all-projects conversation answers with real citations and an honest coverage count.

**Independent test**: Seed several workspaces for user A and one distinctive workspace for user B. Ask about A's projects. All citations resolve to A's rows, the answer reports checked/total counts, and workspace chat history stays unchanged.

### Tests

- [ ] T016 [P] [US2] Add `apps/web/tests/project-context.test.ts`: owned workspaces only, saved workspaces without open tabs, deterministic two-stage ranking, fixed budgets, stripped URLs, prompt-injection text held as data, missing evidence, and truncation disclosure.
- [ ] T017 [P] [US2] Add `apps/web/tests/project-chat.test.ts`: POST/GET persistence and pagination, paired/revoked/foreign-user auth, stable answer IDs, server-resolved citations, model failure, no citations invented by model output, no write tool calls, and no change to workspace chat history.

### Implementation

- [ ] T018 [US2] Build `apps/web/src/project-assistant/context.ts` to gather a compact index of owned workspaces, rank and expand a bounded set, and return source candidates and explicit checked/total/omitted coverage. Reuse safe URL and model-input handling from 008/010; do not fetch arbitrary pages. (depends on T003, T016)
- [ ] T019 [US2] Build `apps/web/src/project-assistant/chat.ts` for user-scoped project history, model call, grounded answer, source-ID validation, and persistence. Keep model-visible data separate from instructions; reject foreign or fabricated citation IDs. (depends on T007–T008, T017–T018)
- [ ] T020 [US2] Add GET/POST `apps/web/app/api/projects/chat/route.ts` using existing Bearer auth, CORS and JSON error conventions. Limit message length, concurrent requests, model time, and history. (depends on T019)
- [ ] T021 [US2] Add an **All projects** entry on the mobile directory and a project chat route/view in `apps/mobile/src/App.tsx`, with API functions in `apps/mobile/src/api.ts`. Show citations as workspace links and checked/total coverage; reuse the voice composer after T014. (depends on T020)
- [ ] T022 [US2] Checkpoint: run project context/chat tests and mobile build; verify that an answer with omitted workspaces says so and that a cited workspace opens its existing workspace view.

---

## Phase 5: User Story 3 — Natural-language Notion and email actions (P1)

**Goal**: “Make a Notion page for that” and “email me that” produce reviewable proposals tied to visible answers. A separate approval performs an allowlisted action; Gmail send still requires its exact-message confirmation.

**Independent test**: From a saved answer, request a Notion page, inspect and approve it once, and see its URL. Request an email, inspect recipient/subject/body, approve preparation, then confirm send once. Cancelled and unapproved proposals call no provider.

### Tests

- [ ] T023 [P] [US3] Add `apps/web/tests/action-proposals.test.ts` for explicit source IDs, ambiguous “that,” immutable snapshot, foreign source, expired/deleted source, unverified recipient, unavailable integration, schema validation, edited payload revalidation, allowed tools only, and no MCP call during interpretation or proposal creation.
- [ ] T024 [P] [US3] Add `apps/web/tests/action-proposal-approval.test.ts` with fake Notion/Gmail connectors: cancel calls none; one approval yields one create/draft; double tap, replay, timeout, and retry do not duplicate an external write; missing credentials and revoked device fail; Gmail send uses the existing exact-message confirm path and cannot send during proposal approval.
- [ ] T025 [P] [US3] Add mobile review tests for source selection, complete payload and destination display, editable fields, cancel, loading and terminal states, copy fallback, and a separate final email-send tap in `apps/mobile/tests/action-review.test.tsx`.

### Implementation

- [ ] T026 [US3] Add a bounded intent classifier and referent resolver under `apps/web/src/project-assistant/actions/`. Accept only supported Notion-create and Gmail-draft intents; bind “that” to a persisted answer/artifact ID or ask the user to choose. Treat transcript, page, and model text as untrusted. (depends on T023)
- [ ] T027 [US3] Implement proposal creation, read, edit/revalidate if contract permits, cancel, expiry, and immutable source snapshot under `apps/web/src/project-assistant/actions/`; add routes in `apps/web/app/api/action-proposals/`. Creation and edits make no MCP calls. (depends on T004–T007, T023, T026)
- [ ] T028 [US3] Implement an approval adapter that invokes the existing 010b tool registry and `ActionRun` safeguards for workspace-scoped answers. For all-projects answers, use the aggregate artifact/action adapter chosen in T004. Recheck owner, connection, destination, source state, payload, and idempotency under concurrency; reconcile uncertain provider outcomes before any retry. (depends on T024, T027)
- [ ] T029 [US3] Add proposal approval route under `apps/web/app/api/action-proposals/[id]/approve/route.ts` and connect Gmail draft/preparation to the existing `.../actions/runs/[runId]/confirm` path or its guarded domain helper. Preserve its recipient validation and once-only send behavior. (depends on T028)
- [ ] T030 [US3] Add natural-language action entry and review UI in `apps/mobile/src/`, with API helpers in `apps/mobile/src/api.ts`. Present the source, scope, destination, full content, and state; separate proposal, approval, and final email send controls. Do not claim success while a run is pending. (depends on T025, T027–T029)
- [ ] T031 [US3] Checkpoint: run proposal and mobile review tests; manually verify a Notion creation and a Gmail send against configured test integrations only after reviewing the exact payload. With integrations unset, verify the copy fallback and typed questions.

---

## Phase 6: User Story 4 — Cross-device continuity (P2)

**Goal**: Reopen saved project answers and action results on mobile; workspace-bound action runs appear in the existing desktop history.

- [ ] T032 [P] [US4] Add `apps/web/tests/project-history.test.ts` for paged project chat, citations after reload, proposal/action links after reload, ownership isolation, and retention/expiry behavior.
- [ ] T033 [US4] Add mobile history and result navigation in `apps/mobile/src/App.tsx` and `apps/mobile/src/api.ts`. Reopen proposals by ID, show Notion links and email status, and link workspace-bound action runs to their desktop-visible workspace record. (depends on T032, T030)
- [ ] T034 [US4] Checkpoint: reload the phone after each stage of the Notion and Gmail flows; compare workspace action history on desktop. Verify an aggregate action is clearly marked as all-projects rather than attributed to an unrelated workspace.

---

## Phase 7: Final verification and documentation

- [ ] T035 Update `apps/mobile/README.md`, `apps/web/README.md`, root `.env.example`, and `specs/015-mobile-voice-project-assistant/quickstart.md` with configuration, migrations, provider limits, local commands, and actual fallback behavior. Keep API keys and device tokens out of docs, logs, and client bundles.
- [ ] T036 Run `pnpm typecheck`, `pnpm --filter @ai-browser/web test`, `pnpm --filter @ai-browser/extension test`, and `pnpm --filter @ai-browser/mobile build`; fix failures. Run any newly added mobile test script explicitly.
- [ ] T037 Complete the quickstart on a phone-sized viewport or real phone: pair, voice permission granted and denied, transcript edit, workspace question, all-projects question, citation navigation, ambiguous “that,” cancelled proposal, approved Notion page, Gmail draft and final send, revoked-device behavior, and no-key fallbacks. Record any unavailable live-service check as unverified rather than passed.
- [ ] T038 Update the feature 015 row in `FEATURES.md` and the requirements checklist after the delivered slices actually pass; identify any remaining optional tap-to-listen work without marking it done.

## Dependency summary

1. T001–T005 settle the design; T006–T009 establish shared state.
2. US1 can ship on existing workspace chat after Phase 1. US2 depends on project chat storage and retrieval. Voice and all-projects work can be built independently once their shared contracts are settled.
3. US3 depends on US2 answer IDs for aggregate sources and on working 010b Notion/Gmail adapters. Workspace-scoped action proposals can be developed against existing workspace answers while aggregate support is built.
4. US4 depends on saved answers and completed actions. Final documentation and status follow verified behavior.
