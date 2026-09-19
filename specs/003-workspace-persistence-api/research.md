# Research: Workspace Persistence API

## 1. Host and routing

- **Decision**: Next.js 16 Route Handlers under `apps/web/app/api/**/route.ts`.
- **Rationale**: Constitution server is Next.js; 001 already has the web shell. One process for later UI reuse.
- **Alternatives considered**: Separate Express app (second deploy); tRPC (extra stack); Server Actions (awkward for extension/curl).

## 2. Database access

- **Decision**: `pg` Pool from `DATABASE_URL`. Parameterized SQL only. Map rows to `@ai-browser/shared` in `apps/web/src/map.ts`.
- **Rationale**: Schema already exists; no ORM required for a weekend CRUD API. Pivot-friendly (any Postgres).
- **Alternatives considered**: Prisma (migration drift vs 001 SQL); Drizzle (fine, extra layer); Timescale-specific client (unnecessary).

## 3. Hypertables

- **Decision**: Do **not** enable Timescale hypertables in 003. Insert into `tab_events` as a regular table. Optional commented `create_hypertable` stays in 001 SQL only.
- **Rationale**: Spec assumption and constitution pivot. App SQL does not change if Tiger is later enabled.
- **Alternatives considered**: Require Tiger (blocks local/Supabase); dual-write (forbidden).

## 4. Pairing auth

- **Decision**: Client sends a high-entropy device token on `POST /api/session` and on every later request as `Authorization: Bearer <token>`. Server stores `SHA-256(DEVICE_TOKEN_SECRET + ":" + token)` (or HMAC-SHA256) in `users.device_token_hash`. Lookup or insert user. Never persist the raw token.
- **Rationale**: Spec US5 / FR-008 / FR-010. Same token on Home and Sidebar → same `user_id`.
- **Alternatives considered**: JWT sessions (more moving parts); Supabase Auth (pivot later, not required); storing raw tokens (forbidden).

## 5. Apply schema

- **Decision**: Document `psql "$DATABASE_URL" -f packages/shared/sql/001_init.sql` in quickstart. Optional idempotent boot check (`SELECT to_regclass('workspaces')`) that logs “run 001_init.sql” rather than auto-migrating production.
- **Rationale**: 001 already owns DDL. Don’t fork a second schema.
- **Alternatives considered**: Auto-run SQL on every server start (ok for hackathon if guarded `IF NOT EXISTS` — 001 file already uses CREATE TABLE without IF NOT EXISTS; keep migrate manual to avoid errors on second run).

## 6. Upsert tab refs

- **Decision**: `PUT /api/tab-refs` body includes `url`, optional `id`, optional `chromeTabId`. If `chromeTabId` matches an existing row for this user, update it; else insert. Assignment via `workspaceId: string | null`.
- **Rationale**: Ingestion (002) will spam snapshots; persistence should not create a new row per focus change when the live tab id is known.
- **Alternatives considered**: Always insert (duplicates explode); unique(url) per user (breaks two tabs on same URL).

## 7. Resolve order

- **Decision**: If `chromeTabId` query param present, match `tab_refs.chrome_tab_id` for this user first. Else match `url` with `ORDER BY last_seen_at DESC LIMIT 1`. No row → `{ workspace: null, tabRef: null }` meaning Other/unknown, HTTP 200.
- **Rationale**: Spec US3; live id beats URL; missing is Other not 404.
- **Alternatives considered**: 404 on miss (feels like the product is broken).

## 8. Archive vs delete

- **Decision**: PATCH `status: "archived"` (or `"active"` to restore). No DELETE workspace in 003. Tab refs stay; `ON DELETE SET NULL` only if a future delete appears.
- **Rationale**: Spec FR-002; archive hides from default GET list (`status != 'archived'`).
- **Alternatives considered**: Soft-delete column (redundant with status).

## 9. CORS / extension

- **Decision**: Allow `Authorization` header. For local extension later, set CORS on API routes to `*` or chrome-extension:// in a small helper. 003 can stay same-origin + curl.
- **Rationale**: 002 will need CORS; don’t block 003 on it.
- **Alternatives considered**: Next rewrite through extension (too early).

## Clarifications

None remaining. Token hashing algorithm is an implementation detail (SHA-256 with server secret).
