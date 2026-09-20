# Data Model: Mobile Companion

**Branch**: 014-mobile-companion | **Date**: 2026-09-19

## Existing (unchanged semantics)

### User (`users`)

`id`, `device_token_hash` (legacy single-token; still accepted by auth), `created_at`.

### Workspace / TabRef / Message / …

Unchanged. Mobile reads/writes through existing user-scoped APIs after device auth.

## New entities

### Device

A paired client credential for one person.

| Field | Meaning |
| --- | --- |
| `id` | Stable id |
| `userId` | Owning person |
| `tokenHash` | Unique hash of Bearer token (plaintext shown once at create/redeem) |
| `kind` | `extension` \| `mobile` (extensible) |
| `label` | Optional human label (e.g. “iPhone”) |
| `createdAt` | When issued |
| `revokedAt` | Null if active; set on revoke |

**Rules**:
- Auth accepts Bearer iff hash matches an active device **or** legacy `users.device_token_hash`.
- Revoked device → 401 on subsequent calls.
- Max 3 active `kind=mobile` devices per user.
- Redeeming pairing creates `kind=mobile`.

### PairingOffer

Short-lived bridge from desktop to a new mobile device.

| Field | Meaning |
| --- | --- |
| `id` | Stable id |
| `userId` | Person who started pairing (desktop session) |
| `codeHash` | Hash of the human/QR code |
| `expiresAt` | ~createdAt + 5 minutes |
| `consumedAt` | Null until successful redeem; then set |
| `createdAt` | When created |

**Rules**:
- Create requires authenticated desktop device/user.
- Redeem requires unauthenticated (or unpaired) mobile; code must match, be unexpired, unconsumed.
- On success: mark consumed, insert Device, return token once.
- At most one active (unconsumed, unexpired) offer per user recommended (creating a new one invalidates or supersedes prior—prefer supersede).

## State transitions

```text
PairingOffer:  open --(expire)--> expired
               open --(redeem)--> consumed + Device(mobile) active

Device:        active --(revoke)--> revoked
```

## Validation

- Code: short, case-insensitive alphabet suitable for typing (e.g. 6–8 chars); never store plaintext.
- Token: long random; hash with same scheme as existing device tokens.
- Labels: optional, length-capped.

## Out of model

- OAuth identities, email login.
- Persisting Chrome session state on the phone.
- Native push notification tokens (unless added later).
