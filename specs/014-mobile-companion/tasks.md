# Tasks: Mobile Companion

**Input**: Design documents in specs/014-mobile-companion/

**Prerequisites**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/pairing.md](contracts/pairing.md), [contracts/mobile-ui.md](contracts/mobile-ui.md)

**Tests**: Focused Vitest for pairing redeem/revoke and auth multi-device (plan). Phone walkthrough in [quickstart.md](quickstart.md). Chat/agent routes are reused from 008/010—do not reimplement.

**Organization**: First shippable slice = **US1 + US2 + US3** (pair → directory → chat). Agents (US4) and voice (US5) follow. Mobile web shell is created in Setup and filled by US2/US3.

## Format: Task ID, parallel marker, story label, path

- **[P]** means separate files with no unfinished dependency.
- **[US1]**–**[US5]** map to spec stories (US4 = agents / former US3b; US5 = voice). Spec “mobile web app” UX is covered in Setup + US2/US3.

## Phase 1: Setup

**Purpose**: Add `apps/mobile` to the monorepo and wire workspace scripts without shipping product UI yet.

- [ ] T001 Create `apps/mobile` Vite + React + TypeScript package (`apps/mobile/package.json`, `vite.config.ts`, `index.html`, `src/main.tsx`) and register it in the pnpm workspace / root `pnpm-workspace` if needed.
- [ ] T002 [P] Add `apps/mobile/.env.example` with `VITE_API_BASE_URL` (and optional mobile origin notes); document run script in `apps/mobile/README.md`.
- [ ] T003 [P] Add placeholder routes shell in `apps/mobile/src/App.tsx` (`/pair`, `/`, `/w/:workspaceId`) with unpaired redirect stub—no API calls yet.

**Checkpoint**: `pnpm --filter @ai-browser/mobile` (or chosen package name) typechecks and serves an empty shell.

---

## Phase 2: Foundational

**Purpose**: Multi-device auth + pairing schema so all stories share one identity model. Blocks Home pairing UI and mobile redeem.

**⚠️ CRITICAL**: No user-story UI until auth resolves `devices` (+ legacy user token).

- [ ] T004 Add migration `packages/shared/sql/014_mobile_devices.sql` for `devices` and `pairing_offers` per [data-model.md](data-model.md); document apply step in web README or migration runner used by the repo.
- [ ] T005 [P] Add shared TypeScript types for Device / PairingOffer (as needed) under `packages/shared/src/` and export them from the package index.
- [ ] T006 Update `apps/web/src/auth.ts` to resolve Bearer via active `devices.token_hash`, then fall back to `users.device_token_hash`; revoked devices → 401.
- [ ] T007 [P] Add focused Vitest coverage for auth multi-device + legacy fallback in `apps/web/tests/auth-devices.test.ts` (or extend the nearest existing auth test helper file).
- [ ] T008 Implement pairing domain helpers (hash code/token, create offer, supersede prior open offer, redeem, enforce max 3 active mobile devices) in `apps/web/src/pairing/` (or equivalent module path).

**Checkpoint**: Migration applied in test DB; Bearer works for legacy and device tokens; pairing helpers unit-testable.

---

## Phase 3: User Story 1 — Pair phone to the same person (P1) 🎯 MVP start

**Goal**: Desktop creates a ~5 min QR/code offer; mobile redeems once and stores a durable device token; desktop can list/revoke mobile devices.

**Independent Test**: From a paired extension user, create offer → redeem on mobile shell → token persists across reload; revoke from Home → mobile gets 401.

- [ ] T009 [P] [US1] Add Vitest for create/redeem/expire/reuse/cap in `apps/web/tests/pairing.test.ts` against [contracts/pairing.md](contracts/pairing.md); confirm failures before routes exist.
- [ ] T010 [US1] Implement `POST /api/pairing/offers` in `apps/web/app/api/pairing/offers/route.ts` (auth required; returns code, expiresAt, qrUrl).
- [ ] T011 [US1] Implement `POST /api/pairing/redeem` in `apps/web/app/api/pairing/redeem/route.ts` (no Bearer; returns deviceToken once + device metadata).
- [ ] T012 [P] [US1] Implement `GET /api/devices` and `POST /api/devices/[id]/revoke` in `apps/web/app/api/devices/` per contract.
- [ ] T013 [US1] Add Home pairing UI (code, QR image/link, expiry, new-code, device list + revoke) in `apps/extension/src/home/` (`Home.tsx`, `home.css`, small `pairing.ts` API helper).
- [ ] T014 [US1] Implement mobile `/pair` page in `apps/mobile/src/` (code entry + `?code=` from QR); persist token (e.g. localStorage); on success navigate to directory route.
- [ ] T015 [US1] Validate pairing expiry, single-use, and revoke flows from specs/014-mobile-companion/quickstart.md (note contract tweaks if any).

**Checkpoint**: Phone can pair and stay paired; revoke works; first-slice auth path proven.

---

## Phase 4: User Story 2 — Browse workspaces on the phone (P1)

**Goal**: Paired mobile shows the same workspace directory (and Other) as desktop; open a workspace to see its saved pages.

**Independent Test**: Two named workspaces on desktop appear on mobile; membership change on desktop visible after mobile refresh.

- [ ] T016 [P] [US2] Add mobile API client in `apps/mobile/src/api.ts` (Bearer from storage; GET workspaces + tab-refs; 401 clears token → `/pair`).
- [ ] T017 [US2] Implement directory view at `apps/mobile/src/` (route `/`) composing workspaces + Other from existing list APIs—no invented mobile-only groups.
- [ ] T018 [US2] Implement workspace pages list at `/w/:workspaceId` in `apps/mobile/src/` (titles/URLs only for this story; chat slot can be empty stub).
- [ ] T019 [US2] Apply phone-sized layout/CSS in `apps/mobile/src/` so pair → list → open workspace works without desktop chrome or horizontal overflow ([contracts/mobile-ui.md](contracts/mobile-ui.md)).
- [ ] T020 [US2] Spot-check directory consistency vs Home per quickstart; empty-state copy when no workspaces.

**Checkpoint**: Mobile is a usable remote directory without chat.

---

## Phase 5: User Story 3 — Ask on a workspace from mobile (P1) 🎯 First slice complete

**Goal**: Same per-workspace chat as desktop (008 routes); history shared both ways.

**Independent Test**: Message from phone appears in desktop workspace chat history after reload (and reverse).

- [ ] T021 [P] [US3] Wire GET/POST `/api/workspaces/:id/chat` in `apps/mobile/src/api.ts` (reuse 008 shapes; handle unpaired 401).
- [ ] T022 [US3] Build chat UI on workspace route in `apps/mobile/src/` (history + composer); no agents/voice yet.
- [ ] T023 [US3] Ensure CORS / API base URL allows the mobile origin for chat and directory calls (configure `apps/web` CORS allowlist or document same-site proxy in `apps/mobile/README.md` / root `.env.example`).
- [ ] T024 [US3] Run first-slice quickstart steps 1–7 (pair, directory, chat, expiry, revoke); fix any contract drift in `specs/014-mobile-companion/contracts/`.

**Checkpoint**: **First shippable slice done** (pair + directory + chat).

---

## Phase 6: User Story 4 — Run agents from mobile (P2)

**Goal**: Trigger existing workspace agents/actions from mobile when 010 (or equivalent) APIs exist; persist results on the shared workspace.

**Independent Test**: Run one agent from mobile; result visible on desktop for that workspace.

- [ ] T025 [US4] Detect available agent/action endpoints; if 010 not present, show quiet “agents unavailable” on mobile workspace view without breaking chat (`apps/mobile/src/`).
- [ ] T026 [US4] When APIs exist, list + run agent from mobile workspace view and refresh result display in `apps/mobile/src/`.
- [ ] T027 [US4] Quickstart step 8 (agents) or document skip condition in `specs/014-mobile-companion/quickstart.md`.

**Checkpoint**: Agents optional but wired when backend ready.

---

## Phase 7: User Story 5 — Light voice on mobile (P3)

**Goal**: Tap-to-listen TTS for chat replies; optional speak-to-ask; never block text path.

**Independent Test**: With voice configured, hear one reply in &lt;10s; without key, chat still works.

- [ ] T028 [P] [US5] Add server TTS adapter route (ElevenLabs preferred) in `apps/web/app/api/` (e.g. `voice/tts`) with key server-side only; pivot stub if unset.
- [ ] T029 [US5] Add tap-to-listen control on assistant messages in `apps/mobile/src/` (no auto-play); hide when voice unavailable.
- [ ] T030 [US5] Optional: browser STT or provider STT into chat composer in `apps/mobile/src/`; degrade cleanly on mic denial.
- [ ] T031 [US5] Quickstart step 9 (voice) or document skip when `ELEVENLABS_API_KEY` missing.

**Checkpoint**: Voice is soft polish on top of chat.

---

## Phase 8: Polish & cross-cutting

- [ ] T032 [P] Update `FEATURES.md` status for 014 (partial vs implemented as accurate).
- [ ] T033 [P] Update `apps/extension/README.md` and `apps/mobile/README.md` with pairing + companion URLs.
- [ ] T034 Run `pnpm typecheck`, `pnpm --filter @ai-browser/web test`, mobile typecheck/build, and extension build.
- [ ] T035 Complete full quickstart walkthrough on a real phone viewport (or device) for first slice; note remaining gaps for agents/voice.

---

## Dependencies and execution order

### Phase dependencies

1. Setup T001–T003 before mobile UI stories.
2. Foundational T004–T008 before US1–US5.
3. **US1** before US2/US3 in practice (need a token), though directory/chat code can be written against a mocked token.
4. **US2** before polished US3 workspace chat UI (same route).
5. **US3** completes first slice; **US4** / **US5** after.
6. Polish after desired stories.

### User story dependencies

- **US1**: After foundational; MVP auth ceremony.
- **US2**: Needs US1 token in real E2E; independently testable with a seeded device token.
- **US3**: Needs US2 workspace route; first-slice gate with US1+US2.
- **US4**: Needs US3 workspace view; soft-depends on 010 APIs.
- **US5**: Needs US3 chat bubbles.

### Parallel examples

- Setup: T002/T003 after T001 skeleton.
- Foundational: T005 || T007 after T004; T006 after T004.
- US1: T009 || types; T010–T012 routes after helpers; T013 || T014 UI after routes.
- US2: T016 then T017/T018; T019 styles parallel to list polish.

## Implementation strategy

1. Scaffold `apps/mobile` + devices/pairing migration + auth.
2. Ship **US1 pairing** (Home + redeem).
3. Ship **US2 directory** then **US3 chat** → **stop and demo first slice**.
4. Add **US4 agents** if 010 exists; else leave unavailable state.
5. Add **US5 voice** behind env key.
6. Docs, FEATURES status, quickstart on a phone.

### MVP scope (first slice)

**Setup + Foundational + US1 + US2 + US3** only. Agents and voice are incremental.
