# Mobile UI Contract

Feature 014 — mobile web companion (`apps/mobile`). Not the Chrome Side Panel; not desktop Home layout.

## Routes (logical)

| Path | Purpose |
| --- | --- |
| `/pair` | Enter code or land from QR (`?code=`); redeem; persist token |
| `/` | Directory (workspaces + Other summary) when paired; else redirect to `/pair` |
| `/w/:workspaceId` | Workspace detail: pages list + chat (first slice) |
| Later | Agents panel; listen / speak controls on chat |

## States

- **Unpaired**: only pairing UI; no workspace data.
- **Pairing error**: expired/used/cap — clear copy; stay on `/pair`.
- **Paired empty**: honest empty directory.
- **Paired**: directory and chat using Bearer from storage.
- **Revoked mid-session**: next API `401` → clear token → `/pair`.

## Desktop Home (extension)

- Control to “pair phone”: shows code + QR image (`qrUrl`), expiry countdown (~5 min), refresh/new code.
- List mobile devices with revoke.
- Does not appear in Side Panel for MVP.

## Voice (later in feature)

- Tap-to-listen on an assistant message; no auto-play.
- Optional hold-to-speak → transcript into chat composer.
- Hidden when voice unavailable.

## Non-goals

- Drag/drop tab organization.
- Opening/closing Chrome tabs.
- Native app chrome / store listing.
