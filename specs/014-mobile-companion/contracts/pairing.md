# Pairing & Devices Contract

Feature 014. Auth for normal APIs remains `Authorization: Bearer <deviceToken>`. Pairing redeem is the exception (code in body).

## Desktop: create offer

`POST /api/pairing/offers`  
Headers: `Authorization: Bearer <existing-device-or-legacy-token>`

Response `201`:

```json
{
  "offer": {
    "expiresAt": "ISO-8601",
    "code": "PLAINTEXT_CODE",
    "qrUrl": "https://mobile-origin/pair?code=PLAINTEXT_CODE"
  }
}
```

Errors: `401` unpaired; `429`/`409` if policy rejects (optional).

Creating a new offer supersedes any prior open offer for that user.

## Mobile: redeem

`POST /api/pairing/redeem`  
Body: `{ "code": "PLAINTEXT_CODE", "label": "optional" }`  
No Bearer required.

Response `201`:

```json
{
  "deviceToken": "PLAINTEXT_TOKEN_ONCE",
  "device": { "id": "uuid", "kind": "mobile", "label": "…" }
}
```

Errors: `400` bad/expired/used code; `409` mobile device cap reached.

Client MUST store `deviceToken` durably (e.g. localStorage) and send as Bearer thereafter.

## List & revoke devices

`GET /api/devices` — Bearer required; returns that user’s devices (id, kind, label, createdAt, revokedAt).

`POST /api/devices/:id/revoke` — Bearer required; sets `revokedAt`; idempotent if already revoked. Cannot be used by a revoked token.

Desktop Home uses these to show “paired phones” and revoke.

## Auth resolution (all existing routes)

1. Parse Bearer token; hash; lookup `devices` where hash matches and `revoked_at IS NULL` → user.
2. Else lookup `users.device_token_hash` (legacy) → user.
3. Else `401`.

## Unchanged product APIs (first slice)

After redeem, mobile calls existing:

- `GET /api/workspaces`, `GET /api/tab-refs` (directory)
- `GET|POST /api/workspaces/:id/chat` (008)

Agents/voice routes when those features exist; out of first-slice contract detail.
