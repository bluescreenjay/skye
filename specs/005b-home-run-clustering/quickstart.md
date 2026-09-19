# Quickstart: Home → run clustering

Proves the Home **organize** control runs 004 clustering and refreshes the directory—without curl for the organize step itself.

## Prerequisites

- 003 API + 004 clustering already working (`GEMINI_API_KEY`, `DEVICE_TOKEN_SECRET`, `DATABASE_URL`)
- Clustering schema applied: `node apps/web/scripts/apply-sql.mjs packages/shared/sql/004_clustering.sql`
- `pnpm --filter @ai-browser/web dev` on `http://127.0.0.1:3000` (or localhost)
- `apps/extension/.env`:

```bash
VITE_API_BASE_URL=http://127.0.0.1:3000
VITE_DEVICE_TOKEN=home-organize-aaaaaaaa
```

Same token for ingest and Home. Rebuild after `.env` changes.

## Seed tabs (Other)

Either browse normal `http(s)` pages with the extension loaded (ingest fills Other), or:

```bash
export B=http://127.0.0.1:3000
export H="Authorization: Bearer home-organize-aaaaaaaa"
curl -s -X POST $B/api/ingest/tabs -H "$H" -H 'content-type: application/json' \
  -d @apps/web/tests/fixtures/mixed-tabs.batch.json
```

Confirm Other has tabs: `curl -s $B/api/tab-refs -H "$H" | head` (many `workspaceId: null`).

## Build and load

```bash
pnpm --filter @ai-browser/extension build
```

Chrome → Load unpacked → `apps/extension/dist`. Toolbar opens Home.

## Checks

1. Home shows Other rail icons; few or no named cards (unless prior runs exist).
2. Click **organize** → control shows in-progress.
3. On success → named workspace cards appear; assigned tabs leave Other. Reload Home → same structure (SC-002).
4. With bad token or API stopped → failure copy; Home chrome remains; no “refs — furniture” dummy cards.
5. Double-click organize during a run → no corrupt directory (`409` or ignored); either wait or “already organizing.”
6. Confirm no Side Panel, no create-workspace control, no suggestions inbox UI.

## Fail if

- Extension invents workspace names without a successful server run
- Organize is only available via curl / command bar
- Home layout was redesigned away from the 005 mock beyond the organize control

Contracts: [home-organize.md](./contracts/home-organize.md), [004 http.md](../004-ai-clustering/contracts/http.md)
