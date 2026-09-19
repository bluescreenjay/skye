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
| `POST /api/cluster/runs`, `GET /api/cluster/runs` | Run AI clustering now; list this user's runs (feature 004) |
| `GET /api/cluster/runs/:id`, `POST /api/cluster/runs/:id/undo` | One run and the tabs it moved; take a run back |
| `GET /api/suggestions`, `POST /api/suggestions/:id/accept`, `POST /api/suggestions/:id/ignore` | Suggestions the AI was not sure enough to apply |
| `GET /api/overview` | Home's read: workspaces with tabs, Other, and pending suggestions in one call |

## Tests

```bash
pnpm --filter @ai-browser/web test
```

Runs against an in-process Postgres (PGlite) with the real 001 schema, so it needs no database and never touches the one in `.env`. It includes an end-to-end suite where the real extension code sends to the real ingest route.

If `next dev` or `next build` has left files named like `cache-life.d 2.ts` in `.next/types`, delete them: they are stale duplicates that make `pnpm typecheck` fail.

## Clustering (feature 004)

`POST /api/cluster/runs` groups a user's unplaced tabs into named workspaces with Gemini. It runs **only when asked** (never on tab events). A group the model is confident about (default 0.7) is applied; a less confident one becomes a suggestion. Every AI placement is marked `ai`, recorded per run, and can be undone; a tab the user placed is never moved. Design: `specs/004-ai-clustering/`.

Configure in the repo-root `.env` (see `.env.example`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `GEMINI_API_KEY` | none | required; server-side only |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | model id; `GEMINI_MODEL_CLUSTER` overrides it for clustering only |
| `CLUSTER_CONFIDENCE_BAR` | `0.7` | at or above it a group is applied, below it suggested |
| `LLM_DAILY_CAP` | `450` | in-memory guardrail on model requests per Pacific-time day |

The tables and the `tab_refs.placement_source` column come from `packages/shared/sql/004_clustering.sql` (safe to re-run). `psql` is not needed:

```bash
node apps/web/scripts/apply-sql.mjs packages/shared/sql/004_clustering.sql   # writes to the database in DATABASE_URL
```

Automated tests use a fake model and never call Gemini. An opt-in check calls the real API (about 2 requests) against an in-process database, never the one in `.env`:

```bash
CLUSTER_LIVE=1 pnpm --filter @ai-browser/web test cluster-live
node apps/web/scripts/score-clusters.mjs <deviceToken>   # SC-001 score for a user's tabs after a run
```
