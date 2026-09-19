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
