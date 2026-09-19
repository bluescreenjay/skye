# HTTP contract: Workspace Persistence API

Base: `http://localhost:3000` (Next.js `apps/web`).
Auth: `Authorization: Bearer <deviceToken>` on all routes except `POST /api/session` (token is in the body there; may also send Bearer).
Errors: `{ "error": string }` with 400 / 401 / 403 / 404.
Success bodies use `@ai-browser/shared` camelCase field names.

## POST /api/session

Ensure a user exists for this device token.

Request:

```json
{ "deviceToken": "opaque-client-generated-secret" }
```

Response `200`:

```json
{ "userId": "uuid" }
```

## GET /api/workspaces

Query: `includeArchived=true` optional.

Response `200`: `{ "workspaces": Workspace[] }`  
Default omits `status === "archived"`.

## POST /api/workspaces

Request: `{ "name": "Hackathon", "emoji": "💻" }` (`emoji` optional)

Response `201`: `{ "workspace": Workspace }`

`401` if missing/invalid bearer. `400` if name empty or >80.

## GET /api/workspaces/:id

Response `200`: `{ "workspace": Workspace }` including archived.  
`404` if not found **for this user**.

## PATCH /api/workspaces/:id

Request: `{ "name"?: string, "emoji"?: string | null, "status"?: "active" | "archived" }`

Response `200`: `{ "workspace": Workspace }`  
`403`/`404` if id belongs to another user (indistinguishable 404 preferred).

## GET /api/tab-refs

Query: `workspaceId=<uuid>` or `other=true`. Omit both → all tab refs for user.

Response `200`: `{ "tabRefs": TabRef[] }`

## PUT /api/tab-refs

Upsert snapshot + optional assignment.

Request:

```json
{
  "id": "optional-uuid",
  "url": "https://example.com",
  "title": "Example",
  "snippet": "",
  "chromeTabId": 42,
  "workspaceId": "uuid-or-null"
}
```

A record is the same *page*, not the same Chrome tab. Match an existing row by `id`, else by this user's `url`; else insert. Chrome's `chromeTabId` only lasts for one browser session, so it is never used to find a record. Setting a `chromeTabId` clears it from any other record of this user, because a tab id belongs to one live tab.  
`workspaceId: null` → Other. Omit `workspaceId` on update → leave membership unchanged; on insert → Other.

Response `200`: `{ "tabRef": TabRef }`

## PATCH /api/tab-refs/:id

Request: `{ "workspaceId": "uuid" | null, "title"?: string, "snippet"?: string }`

Response `200`: `{ "tabRef": TabRef }`  
`400` if `workspaceId` is not this user’s workspace.

## GET /api/resolve

Query: `chromeTabId` and/or `url` (at least one required).

Response `200`:

```json
{
  "workspace": null,
  "tabRef": null
}
```

or populated `Workspace` / `TabRef`. Never 404 for “not assigned.”

Precedence: `chromeTabId` match (the live tab, kept current by `PUT /api/tab-refs` and `POST /api/ingest/tabs`), then latest `url` match for this user.

## POST /api/tab-events

Request:

```json
{
  "eventType": "reassigned",
  "url": "https://example.com",
  "title": "",
  "chromeTabId": 42,
  "tabRefId": "uuid-or-null",
  "workspaceId": "uuid-or-null",
  "time": "optional-iso"
}
```

Response `201`: `{ "tabEvent": TabEvent }`  
Server fills `id`, `userId`, `time` (now if omitted).

## GET /api/tab-events

Query: `limit` default 50, max 200.

Response `200`: `{ "tabEvents": TabEvent[] }` newest first, this user only.

## POST /api/ingest/tabs

The Chrome extension's batched feed (feature 002). Full contract, including the request body and the rules for matching tabs, is in `specs/002-tab-ingestion-extension/contracts/ingest-api.md`.

Auth: `Authorization: Bearer <deviceToken>` of at least 8 characters. Unlike the other routes, a token the server has not seen before **creates its user**, because the extension has no separate pairing step. A shorter token is `401`.

Response `200`: `{ "accepted": n, "duplicates": m }`. Each event is stored once by its client-generated `id`, so re-sending a batch reports duplicates instead of storing them again. `400` for a body that fails validation (the message names the item), `413` for more than 100 events, 500 tabs, or 1 MB, `500` for a server error (the extension retries).

A page is one record per user and address across browser restarts. Each snapshot refreshes the record's live `chromeTabId` and clears that id from any other record; a `fullSnapshot: true` request clears the id of every record it does not list.

## Auth failures

Missing/unknown token → `401`. Do not leak whether another user’s id exists (`404` for cross-user ids).
