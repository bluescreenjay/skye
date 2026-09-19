# Implementation Plan: Shared Domain Model

**Branch**: `001-shared-domain-model` | **Date**: 2026-09-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-shared-domain-model/spec.md`

## Summary

Stand up the AI Browser monorepo so the Chrome extension (future Home + Side Panel) and the Next.js server share one TypeScript domain model and a Postgres schema skeleton. No product UI, clustering, or chat. Workspaces are durable, user-scoped records; tab activity is a time-ordered event stream. Preferred store is Tiger Data (Timescale); pivot is ordinary Postgres. Env examples for Tiger/Gemini (and later ElevenLabs) with no committed secrets.

## Technical Context

**Language/Version**: TypeScript 5.x (strict) on Node 22 LTS; package manager pnpm 9+

**Primary Dependencies**: pnpm workspaces; `packages/shared` (types only this feature); Next.js App Router empty shell in `apps/web`; Chrome MV3 empty shell in `apps/extension` via Vite + CRXJS (Plasmo is an equivalent pivot)

**Storage**: Tiger Data Timescale Postgres preferred (`tab_events` hypertable). Pivot: Supabase/plain Postgres, `tab_events` as a normal table. Schema files live in-repo; live DB connection is optional for this feature.

**Testing**: `tsc --noEmit` across workspaces; a small shared-package compile test that both apps import the eight entities. No product E2E yet.

**Target Platform**: macOS/Linux developers; later Chrome 120+ MV3 and a Node-hosted Next.js API. This feature only needs local compile.

**Project Type**: pnpm monorepo (extension + web/API + shared library)

**Performance Goals**: Not user-facing. Shared package typecheck under 10s on a laptop.

**Constraints**: No secrets in git; no Home/Sidebar/AI code; every durable row has `user_id`; vendor calls isolated so Gemini/Tiger can pivot without rewriting types.

**Scale/Scope**: One repo, three packages, eight entities, one SQL skeleton, env examples. Empty shells only.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How this plan complies |
| --- | --- | --- |
| I. Workspace-First | PASS | Workspace is an independent row with status; not defined as “open tabs.” |
| II. Extension presents; server decides | PASS | Empty extension + empty Next.js shells; clustering/AI not in this feature. Shared IDs prevent later client-side identity forks. |
| III. User corrections win | PASS | `Correction` entity exists; no clustering shipped. |
| IV. Least-power actions | PASS | No agents, MCP, or computer-use. `ActionRun` is a stub type only. |
| V. One TypeScript surface | PASS | Canonical types in `packages/shared`; apps import them. |
| VI. Demo-hard, architecture-soft | PASS | Foundation only; no platform theater (no vector DB, no mobile). Prize vendors via env, not required live. |
| VII. Two surfaces | PASS | Model supports Home (list by user) and Sidebar (workspace for a tab) without implementing either. |
| Pivots | PASS | Types/SQL avoid Tiger-only column types except optional hypertable DDL behind a comment/guard. |
| Secrets | PASS | `.env.example` placeholders only. |

**Gate result (pre-research): PASS.** No complexity-tracking violations.

## Project Structure

### Documentation (this feature)

```text
specs/001-shared-domain-model/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
└── tasks.md             # Phase 2 — /speckit-tasks, not this command
```

### Source Code (repository root)

```text
apps/
├── extension/           # Chrome MV3 empty shell (Vite + CRXJS)
│   ├── manifest.config.ts
│   ├── src/background.ts
│   └── package.json
├── web/                 # Next.js App Router empty shell (API later)
│   ├── app/page.tsx     # placeholder, not Home product UI
│   ├── package.json
│   └── tsconfig.json
packages/
└── shared/
    ├── src/
    │   ├── index.ts     # re-exports
    │   └── domain.ts    # User, Workspace, TabRef, TabEvent, ...
    ├── sql/
    │   └── 001_init.sql
    ├── package.json
    └── tsconfig.json
package.json             # pnpm workspace root
pnpm-workspace.yaml
.env.example
.gitignore
```

**Structure Decision**: Constitution layout — `apps/extension`, `apps/web`, `packages/shared`. SQL skeleton lives with shared so both apps stay aligned. Next.js is the future API host, not the in-tab UI.

## Complexity Tracking

> No constitution violations. Table left empty.

## Phase 0 / Phase 1

Research, data model, contracts, and quickstart are in this directory (see artifacts below). Post-design constitution check: still **PASS** — design adds types/SQL/env only, no second identity scheme, no product UI.

## Next

`/speckit-tasks` to break this plan into implementation tasks.
