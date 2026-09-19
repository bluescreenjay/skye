# Contract: tab ingest endpoint

The extension **calls** this endpoint. The server that **implements** it is feature 003. Until then the stub receiver (`apps/extension/scripts/stub-receiver.mjs`) implements exactly this contract so the extension can be verified.

## Request

```
POST {VITE_API_BASE_URL}/api/ingest/tabs
Authorization: Bearer {VITE_DEVICE_TOKEN}
Content-Type: application/json
```

```jsonc
{
  "batchId": "6f1c…",            // UUID, new per request attempt
  "sentAt": "2026-09-19T10:15:30.123Z",
  "fullSnapshot": false,          // true = `tabs` lists EVERY reportable open tab, including ones still settling
  "active": { "windowId": 12, "chromeTabId": 345 },  // both null if the active tab is not reportable
  "tabs": [                       // TabSnapshotInput[]; may be empty
    {
      "chromeTabId": 345,
      "windowId": 12,
      "active": true,
      "url": "https://example.com/a",
      "title": "Example",
      "snippet": "…up to 2000 chars of plain text…",
      "lastSeenAt": "2026-09-19T10:15:29.900Z"
    }
  ],
  "events": [                     // TabEventInput[], in the order they occurred
    {
      "id": "0b8e…",             // UUID, stable across retries
      "time": "2026-09-19T10:15:28.010Z",
      "chromeTabId": 345,
      "url": "https://example.com/a",
      "title": "Example",
      "eventType": "opened"      // opened | updated | activated | closed
    }
  ]
}
```

`tabs[].active` is a point-in-time hint and is not refreshed when the front tab changes; the request-level `active` and the `activated` events are authoritative. Limits: at most 100 `events`; `tabs` no larger than the open tab count. Types are defined in `packages/shared/src/ingest.ts` (see `shared-ingest-types.md`).

## Response

| Status | Meaning | Extension behavior |
| --- | --- | --- |
| `200` `{ "accepted": n, "duplicates": m }` | Batch processed. Events whose `id` was already stored count as `duplicates`. | Acknowledge, delete the sent range. |
| `401` / `403` | Missing or rejected device token | Stop sending, keep the backlog, mark `auth_failed`, show the badge. Resumes only after the extension is reloaded or the browser restarts. |
| `413` / `400` / `422` | Too large, or invalid | Split the events in half and send the halves separately until one event is left; quarantine a lone event that is still rejected, and quarantine snapshots the server rejects on their own. |
| `408` / `429` / `5xx` / network error / timeout / any other status (for example `404`) | Transient | Keep everything; retry with exponential backoff (2 s to 5 min, up to 20% jitter). Nothing is sent before the retry time. |

A `Retry-After` header on 429/503, when present, overrides the computed delay.

## Server obligations (hand-off to feature 003)

1. **Authenticate** by the bearer token and derive `user_id` from it. Never trust a user id from the body.
2. **Identify tabs** (FR-017). The server, not the extension, matches a reported tab to an existing `TabRef` for that user (for example by address) or creates one. Matching by address alone is imperfect (two tabs on one page, redirects); resolving that is 003's job.
3. **Refresh live ids.** Update the stored `chromeTabId` from each snapshot. On `fullSnapshot: true`, any of the user's tabs **not** listed are no longer live and must lose their `chromeTabId`. This is what re-attaches records after a browser restart.
4. **De-duplicate events** by `events[].id`: store once, count repeats as `duplicates`, still return `200`.
5. **Set membership.** Assign `workspace_id` (null = Other until decided); the extension never sends it.
6. **Be lenient.** Ignore unknown fields. Events in one request are in occurrence order but may span up to 24 hours and interleave with earlier requests; do not assume `time` is monotonic across requests.
7. **Idempotent snapshots.** Re-applying the same snapshot is harmless.

## Extension guarantees

- Events are sent in the order they occurred, and a range is deleted only after `200`.
- `events[].id` is unique and never changes across retries.
- Nothing from incognito windows or non-`http(s)` pages is ever included.
- `snippet` is plain text of at most 2000 characters, never markup.
- Only one request is in flight at a time.
