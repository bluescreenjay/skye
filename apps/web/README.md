# @ai-browser/web

Next.js (App Router) host for the workspace **persistence API**. This app is
not the product Home or Chrome sidebar.

## Schema

Apply the shared 001 DDL once (ignore errors if tables already exist):

```bash
psql "$DATABASE_URL" -f packages/shared/sql/001_init.sql
```

`DATABASE_URL` and `DEVICE_TOKEN_SECRET` live in the repo-root `.env`.

## Dev

```bash
pnpm --filter @ai-browser/web dev
```

Pairing and workspace curls: `specs/003-workspace-persistence-api/quickstart.md`.

## Routes

| Route | Purpose |
| --- | --- |
| `POST /api/session` | Pair a device token with a user |
| `/api/workspaces`, `/api/workspaces/:id` | Create, list, rename, archive |
| `/api/tab-refs`, `/api/tab-refs/:id` | Tab records and their workspace |
| `GET /api/resolve` | Which workspace is this tab in? |
| `/api/tab-events` | Read or append tab events |
| `POST /api/ingest/tabs` | The Chrome extension's batched feed (`specs/002-tab-ingestion-extension/contracts/ingest-api.md`) |

## Tests

```bash
pnpm --filter @ai-browser/web test
```

Runs against an in-process Postgres (PGlite) with the real 001 schema, so it needs no database and never touches the one in `.env`. It includes an end-to-end suite where the real extension code sends to the real ingest route.

If `next dev` or `next build` has left files named like `cache-life.d 2.ts` in `.next/types`, delete them: they are stale duplicates that make `pnpm typecheck` fail.
