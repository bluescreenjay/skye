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
| `POST /api/workspaces/:id/chat`, `GET /api/workspaces/:id/chat` | Ask about a workspace and get a streamed answer; read its saved conversation (feature 008) |

## Tests

```bash
pnpm --filter @ai-browser/web test
```

Runs against an in-process Postgres (PGlite) with the real 001 schema, so it needs no database and never touches the one in `.env`. It includes an end-to-end suite where the real extension code sends to the real ingest route.

If `next dev` or `next build` has left files named like `cache-life.d 2.ts` in `.next/types`, delete them: they are stale duplicates that make `pnpm typecheck` fail.

## Clustering (feature 004)

`POST /api/cluster/runs` groups a user's unplaced tabs into named workspaces with an LLM. It runs **only when asked** (never on tab events). A group the model is confident about (default 0.7) is applied; a less confident one becomes a suggestion. Every AI placement is marked `ai`, recorded per run, and can be undone; a tab the user placed is never moved. Design: `specs/004-ai-clustering/`.

Configure in the repo-root `.env` (see `.env.example`). One AI provider is active per deployment; switching is only config:

| Variable | Default | Meaning |
| --- | --- | --- |
| `LLM_PROVIDER` | `vt` | `vt` = Virginia Tech ARC LLM API (default); `gemini` = Google Gemini (backup, works from any network) |
| `VT_LLM_API_KEY` | none | your personal VT key. **The VT API works only on the VT Campus VPN**; off it every call fails with a message saying so |
| `LLM_MODEL`, `LLM_MODEL_CLUSTER`, ... | `gpt-oss-120b-thinking-low` (clustering, commands, chat), `gpt-oss-120b` (actions) | VT model ids; effort is part of the id |
| `LLM_CONCURRENCY` | `8` for gpt-oss-120b | local cap on simultaneous requests (the service allows 10 and rejects the rest) |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | none, `gemini-3.5-flash-lite` | the backup provider (free tier: 15 requests a minute) |
| `CLUSTER_CONFIDENCE_BAR` | `0.7` | at or above it a group is applied, below it suggested |
| `LLM_DAILY_CAP` | `450` | in-memory guardrail on model requests per Pacific-time day |

The tables and the `tab_refs.placement_source` column come from `packages/shared/sql/004_clustering.sql` (safe to re-run). `psql` is not needed:

```bash
node apps/web/scripts/apply-sql.mjs packages/shared/sql/004_clustering.sql   # writes to the database in DATABASE_URL
```

Automated tests use a fake model and never call a real provider. An opt-in check calls the active provider for real (about 2 requests; on the VT provider you must be on the VPN) against an in-process database, never the one in `.env`:

```bash
CLUSTER_LIVE=1 pnpm --filter @ai-browser/web test cluster-live                       # the default (vt) provider
LLM_PROVIDER=gemini CLUSTER_LIVE=1 pnpm --filter @ai-browser/web test cluster-live   # the backup
node apps/web/scripts/score-clusters.mjs <deviceToken>   # SC-001 score for a user's tabs after a run
```

## Chat (feature 008)

`POST /api/workspaces/:id/chat` answers a question about **one workspace**, using that workspace's tabs (title, address without its query string, a short excerpt), its plan items, and the recent conversation, and saves both messages in the existing `messages` table. `GET` on the same path reads the saved conversation. This is the server side that the sidebar chat panel (feature 006) calls; it has no screen of its own. Design and contracts: `specs/008-workspace-ai-chat/` (`contracts/http.md` is the one to read).

- **A model is called only when a message is sent**, once per message (and once more for an explicit `{ "retry": true }`). Reading history, changing tabs, or opening a workspace never calls one.
- **Two response modes.** The default is an event stream (`meta`, then `delta` pieces as they are written, then `done`); the model's first words arrive in about a second. `"stream": false` returns one JSON body when the reply is complete. Anything that fails before the first words is an ordinary JSON error, and the person's message is saved.
- **Nothing half-written is kept.** The assistant message is saved only after the whole reply arrived. A reply that breaks off ends with an `error` event (`interrupted`), and the person retries.
- **One reply at a time per workspace** (`409 reply_in_progress`), kept in server memory, so it covers a single server process.
- **Nothing crosses a boundary.** Every query is scoped to the signed-in user and the workspace. Text from tabs, plan items, and the workspace name goes only inside one JSON data block in the system message and is marked as untrusted; the assistant has no tools. Message text and tab content are never logged.
- **Model.** Chat defaults to `gpt-oss-120b-thinking-low` on the VT provider (override with `LLM_MODEL_CHAT`; `LLM_PROVIDER=gemini` uses the backup). It shares the daily request guardrail (chat's share is 170 of `LLM_DAILY_CAP`).
- **Rules for clients.** Show replies as plain text or sanitized markdown and **never auto-load remote images, links, or embeds from a reply**; show `contextInfo` ("based on 9 of 9 tabs"); send one message at a time and respect `replying`; read the stream with `fetch` (not `EventSource`, which cannot send the `Authorization` header). The full list is in `contracts/http.md`.

The one schema addition is an index, from `packages/shared/sql/008_chat.sql` (safe to re-run):

```bash
node apps/web/scripts/apply-sql.mjs packages/shared/sql/008_chat.sql   # writes to the database in DATABASE_URL
```

Automated tests use a fake chat model and never call a real provider. An opt-in check calls the active provider for real (about 15 requests; on the VT provider you must be on the VPN) against an in-process database, never the one in `.env`:

```bash
CHAT_LIVE=1 pnpm --filter @ai-browser/web test chat-live --disable-console-intercept                       # the default (vt) provider
LLM_PROVIDER=gemini CHAT_LIVE=1 pnpm --filter @ai-browser/web test chat-live --disable-console-intercept   # the backup
```
