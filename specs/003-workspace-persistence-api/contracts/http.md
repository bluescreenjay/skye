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

If `chromeTabId` matches an existing row for this user, update that row; else insert.  
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

Precedence: `chromeTabId` match, then latest `url` match for this user.

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

## Auth failures

Missing/unknown token → `401`. Do not leak whether another user’s id exists (`404` for cross-user ids).
