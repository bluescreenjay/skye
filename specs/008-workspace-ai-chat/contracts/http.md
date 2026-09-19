# Contract: Workspace chat HTTP API (008)

Base: the Next.js app in `apps/web` (same host as 003 and 004). Two routes, both under `/api/workspaces/:id/chat`. They follow the 003 conventions: `Authorization: Bearer <deviceToken>` (unknown or missing token → `401`), CORS headers from `src/json.ts`, JSON errors as `{ "error": string, "code": string }`. Every query is scoped to the authenticated user; another user's workspace id is `404`, never `403`.

Types are in [shared-chat-types.md](./shared-chat-types.md). What the model is given and how streaming behaves are in [model.md](./model.md).

## POST /api/workspaces/:id/chat

Send a message to the workspace's conversation and get the assistant's reply.

Request:

```json
{ "message": "What have I found so far?", "stream": true }
```

- `message`: a string, 1 to 4,000 characters after trimming. Required unless `retry` is true.
- `retry`: `true` answers the workspace's newest **unanswered** user message without creating another one. Send `retry` **or** `message`, not both.
- `stream`: default `true`. `false` returns one JSON body when the reply is complete.

### Success, streamed (`stream` true or omitted): `200 text/event-stream`

Headers: `content-type: text/event-stream; charset=utf-8`, `cache-control: no-cache, no-transform`, `x-accel-buffering: no`, plus CORS. The response is sent only **after the model has produced its first piece**, so everything that can fail before that is an ordinary JSON error (below). Events, in order:

```text
event: meta
data: {"userMessage":{...Message},"context":{"tabsIncluded":9,"tabsTotal":9,"planItemsIncluded":0,"messagesIncluded":1}}

event: delta
data: {"text":"You've opened nine tabs"}

event: delta
data: {"text":" for your Kyoto trip so far: ..."}

event: done
data: {"assistantMessage":{...Message}}
```

`meta` comes first with the saved user message and what the answer is based on. `delta` repeats. It ends with exactly one `done` (the saved assistant message; its `content` equals the concatenated deltas) **or** one `error`:

```text
event: error
data: {"code":"model_error","message":"The answer was interrupted. Your message is saved; retry to get a full answer."}
```

An `error` event means text had already started, and **no assistant message was saved**. Codes there: `model_error`, `budget_exhausted` (never after start in practice), `interrupted`.

### Success, one body (`stream: false`): `200 application/json`

`ChatReply`: `{ "userMessage": Message, "assistantMessage": Message, "context": ChatContextInfo }`.

### Errors (JSON, before any streamed text)

| Status | `code` | Meaning | User message saved? |
| --- | --- | --- | --- |
| `400` | `invalid_message` | body is not a JSON object; `message` missing, not a string, or blank; both `message` and `retry` sent | no |
| `400` | `message_too_long` | over 4,000 characters (body includes `limit`) | no |
| `400` | `not_a_workspace` | the id is `other`: chat belongs to a workspace | no |
| `401` | | missing or unknown token | no |
| `404` | | workspace not found (or another user's) | no |
| `409` | `reply_in_progress` | a reply is already being written for this workspace | no |
| `409` | `nothing_to_retry` | `retry` was sent but the newest message is not an unanswered user message | n/a |
| `429` | `budget_exhausted` | the AI service is busy, its quota or the daily allowance is used up | **yes** |
| `502` | `model_error` | the AI service is unreachable, timed out, errored, or the required network (the VT VPN) is off | **yes** |
| `503` | `model_unconfigured` | no AI provider key is configured on the server | no |

Every error body has `error` (a plain-language sentence a user can read) and `code`. When the user's message was saved, the body also has `userMessage` (the saved `Message`) so a client can show it and offer Retry. Messages never contain the prompt, tab content, or the vendor's response.

## GET /api/workspaces/:id/chat

Read the saved conversation. Makes **no model call**.

Query: `limit` (default 50, max 200) and `before` (a message id: return only messages older than that one). Without `before` you get the **newest** page.

Response `200`: `ChatHistoryPage`:

```json
{
  "messages": [ { "id": "…", "userId": "…", "workspaceId": "…", "role": "user", "content": "…", "createdAt": "…" } ],
  "hasMore": true,
  "replying": false,
  "unansweredMessageId": null
}
```

`messages` are oldest first within the page. To load earlier history pass the first message's id as `before`. `unansweredMessageId` is set when the newest message is a user message with no reply (show Retry, send `{ "retry": true }`). `replying` is true while a reply is in flight (disable the input). Errors: `400 invalid_cursor` (`before` is not a message of this workspace), `401`, `404`, `400 not_a_workspace` for `other`.

## Rules for clients (feature 006 and later)

1. **Render replies as plain text or sanitized markdown. Never auto-load remote images, links, or embeds from a reply.** A page's text can try to make the assistant output an image whose address carries data; that only works if the client fetches it.
2. Show `context` ("based on 9 of 9 tabs") so people know what the answer covers, especially when `tabsIncluded` is less than `tabsTotal`.
3. Send one message at a time per workspace and respect `replying`.
4. Treat an `error` event as "no reply was saved": offer Retry (`{ "retry": true }`), never re-send the text.
5. Read the stream with `fetch` and a stream reader, not `EventSource` (it cannot send the `Authorization` header).
6. Do not poll history to look for new replies; a reply arrives on the request that asked for it.

## Not in this feature

Editing or deleting messages, message search, chat for the Other bucket, tool or action execution, voice, and any change to how tabs are organized.

## Fail if

- A model request is made for anything except a user sending or retrying a message
- More than one model request is made for one user message, or two replies interleave in one workspace
- A failed, interrupted, or abandoned reply is saved or shown as a complete assistant message
- A failed send loses or duplicates the user's message, or a retry creates a second user message
- Anything from another workspace or another user reaches the model, the response, or the history
- Message text, tab content, or model output appears in server logs or error bodies
