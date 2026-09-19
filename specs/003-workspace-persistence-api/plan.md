# Implementation Plan: Workspace Persistence API

**Branch**: `003-workspace-persistence-api` | **Date**: 2026-09-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-workspace-persistence-api/spec.md`

## Summary

Add a user-scoped HTTP API on `apps/web` (Next.js Route Handlers) so Home and the Chrome sidebar can share durable workspaces. Auth is a device pairing token hashed at rest (`users.device_token_hash`). Reuse `@ai-browser/shared` types and `packages/shared/sql/001_init.sql`. Postgres via `DATABASE_URL` (Tiger preferred, plain Postgres/Supabase pivot). No hypertables required. No Home/Sidebar UI, clustering, or chat.

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22, Next.js 16 App Router (`apps/web`)

**Primary Dependencies**: `@ai-browser/shared`; `pg` (or `postgres`); Web Crypto / Node `crypto` for SHA-256 hashing of pairing tokens

**Storage**: Existing 001 Postgres schema. Apply `packages/shared/sql/001_init.sql` if tables are missing. `tab_events` is a normal table; do **not** call `create_hypertable` unless Tiger is confirmed and optional.

**Testing**: `tsc --noEmit`; curl/quickstart against `next dev` with two pairing tokens. No product E2E UI.

**Target Platform**: Localhost Next.js; later Vultr. Chrome clients in later features.

**Project Type**: Web API (monorepo `apps/web`) consumed by extension/Home later

**Performance Goals**: List/resolve round trip comfortable under 2s on a laptop DB (SC-001 10s budget).

**Constraints**: Every query `WHERE user_id = $currentUser`. Raw pairing token never stored. No Gemini. Feature 002 may be absent — API must work with curl.

**Scale/Scope**: CRUD workspaces, upsert/assign tab_refs, resolve, append/list tab_events, pair/session. No plan/message/action routes.

## Constitution Check

*GATE: Must pass before Phase 0. Re-check after Phase 1.*

| Principle | Status | How this plan complies |
| --- | --- | --- |
| I. Workspace-First | PASS | Workspaces are rows independent of live tabs; empty workspaces still list. |
| II. Extension presents; server decides | PASS | Persistence and identity live on Next.js; no clustering in the client. |
| III. User corrections win | PASS | Assign/move is explicit; no auto-clustering. |
| IV. Least-power | PASS | No agents/MCP. Events are inserts. |
| V. One TypeScript surface | PASS | Request/response map to `@ai-browser/shared` types. |
| VI. Demo-hard | PASS | No Timescale requirement; no UI; prize vendor is just `DATABASE_URL`. |
| VII. Two surfaces | PASS | Pairing lets Home and Sidebar share one user; this feature does not build those UIs. |
| Secrets | PASS | Hash token; `.env` already gitignored. |

**Gate result: PASS.**

## Project Structure

### Documentation (this feature)

```text
specs/003-workspace-persistence-api/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
└── tasks.md             # /speckit-tasks later
```

### Source Code (repository root)

```text
apps/web/
├── app/
│   ├── layout.tsx              # existing placeholder
│   ├── page.tsx                # existing; not product Home
│   └── api/
│       ├── session/route.ts    # POST pair / bind token → user
│       ├── workspaces/
│       │   ├── route.ts        # GET list, POST create
│       │   └── [id]/route.ts   # GET one, PATCH rename/archive
│       ├── tab-refs/
│       │   ├── route.ts        # GET list, PUT upsert
│       │   └── [id]/route.ts   # PATCH assign/move
│       ├── resolve/route.ts    # GET ?chromeTabId=&url=
│       └── tab-events/route.ts # POST append, GET list
├── src/
│   ├── db.ts                   # pg pool from DATABASE_URL
│   ├── auth.ts                 # hash token, load user, 401
│   ├── map.ts                  # snake_case rows → shared types
│   └── domain-check.ts         # existing import check
packages/shared/
├── src/domain.ts               # unchanged contract
└── sql/001_init.sql            # apply on first boot or documented migrate
.env.example                    # DATABASE_URL, DEVICE_TOKEN_SECRET already
```

**Structure Decision**: Keep API inside `apps/web` App Router. No new package. Extension does not call this yet (002).

## Complexity Tracking

> No constitution violations.

## Next

`/speckit-tasks` then `/speckit-implement`.
