# Implementation Plan: Home → run clustering

**Branch**: `005b-home-run-clustering` | **Date**: 2026-09-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005b-home-run-clustering/spec.md`

## Summary

Add one **organize** control on the existing Home page that calls the shipped 004 endpoint `POST /api/cluster/runs` with the same Bearer token as directory loads, then reloads workspaces + tab-refs so named cards appear. No clustering logic in the extension. No Side Panel, ⌘K, create-workspace, or suggestions UI. Keep the 005 mock layout; only minimal chrome for idle / running / success outcome / failure copy.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), React 19 Home page in `apps/extension`

**Primary Dependencies**: Existing Home (`src/home/*`), `loadConfig` / Bearer pairing, 004 cluster HTTP contract, `@ai-browser/shared` types if useful for run response

**Storage**: None new. Server already persists applied workspaces; Home only refreshes via GET

**Testing**: `pnpm --filter @ai-browser/extension typecheck`; Vitest for client helper that maps HTTP outcomes → UI states (success / skipped / in-progress / failure); quickstart against live API + Gemini key

**Target Platform**: Chrome unpacked extension + local Next API (`VITE_API_BASE_URL`)

**Project Type**: Extension UI consuming existing web API

**Performance Goals**: Match 004 sync run expectation (under ~30s for modest tab sets); UI must show in-progress within one interaction; SC-001 demo under two minutes excluding model setup

**Constraints**: Same device token as ingest/Home. Never log the token. Never invent dummy workspaces. Do not POST create workspace from Home. Do not call Gemini from the extension. Respect 409 `run_in_progress` and 503 `model_unconfigured` with quiet copy.

**Scale/Scope**: One button + status line on Home; `runCluster` client + wire into `Home.tsx`; no new routes in `apps/web`

## Constitution Check

*GATE: Must pass before Phase 0. Re-check after Phase 1.*

| Principle | Status | How this plan complies |
| --- | --- | --- |
| I. Workspace-First | PASS | Organize creates/fills durable workspaces via 004; Home then shows them as cards. |
| II. Extension presents; server decides | PASS | Extension only triggers and refreshes; Gemini + apply stay on server. |
| III. User corrections win | PASS | No suggestions accept UI here; 004 already respects user placements; 007 later. |
| IV. Least-power | PASS | Single `fetch` to existing endpoint; no agents in the client. |
| V. One TypeScript surface | PASS | Extend existing React Home modules. |
| VI. Demo-hard | PASS | One click from Home after ingest; failures stay quiet and recoverable. |
| VII. Two surfaces | PASS | Home only; Side Panel still out of scope. |
| Secrets | PASS | Reuse `VITE_DEVICE_TOKEN`; never log it. |
| Stack | PASS | No new stack; mock CSS remains for Home chrome. |

**Gate result: PASS** (no new exceptions).

**Post-design re-check:** Unchanged. Contracts only consume 004 HTTP; no Side Panel or new-tab override.

## Project Structure

### Documentation (this feature)

```text
specs/005b-home-run-clustering/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── home-organize.md
└── tasks.md                 # /speckit-tasks later
```

### Source Code (repository root)

```text
apps/extension/src/home/
├── Home.tsx                 # CHANGED: organize control + status
├── api.ts                   # CHANGED: runCluster() → POST /api/cluster/runs
└── organize.ts              # NEW (optional): map response/status → UI copy
apps/extension/tests/
└── home-organize.test.ts    # NEW: outcome mapping / no dummy seed
apps/web/                    # unchanged for 005b
```

**Structure Decision**: Extend the 005 Home surface only. Reuse 004 API as-is; do not add web routes.

## Complexity Tracking

> None — no constitution violations.
