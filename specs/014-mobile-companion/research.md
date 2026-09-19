# Research: Mobile Companion

**Branch**: 014-mobile-companion | **Date**: 2026-09-19

## 1. Multi-device auth vs single `users.device_token_hash`

**Decision**: Add a `devices` table (`user_id`, `token_hash` UNIQUE, `kind`, `label`, `revoked_at`). Auth resolves `Authorization: Bearer` by looking up an active (non-revoked) device hash, then falls back to legacy `users.device_token_hash` so existing extension installs keep working. Pairing redemption inserts a new `devices` row and returns the plaintext token once.

**Rationale**: Today one hash per user cannot represent desktop + phone. A devices table matches FR-003/FR-005 without forcing every extension rebuild to re-pair immediately if legacy fallback remains.

**Alternatives considered**: Replace `users.device_token_hash` only (breaking); share one token across devices (revocation impossible per device); full OAuth (out of scope for 014).

## 2. Pairing offer shape

**Decision**: Table `pairing_offers` with hashed code, `user_id`, `expires_at` (~5 minutes from create), `consumed_at` null until redeem. Desktop `POST` creates offer and returns plaintext code + payload for QR (URL or `skye://pair?code=` / https mobile deep link to redeem page). Redeem is `POST` with code from unpaired mobile; single-use; reject expired/consumed/unknown.

**Rationale**: Spec FR-001–FR-004; 5-minute default from clarify session.

**Alternatives considered**: JWT-only offers without DB (harder revoke/single-use); long-lived codes (weaker); QR encoding full device token (leaks durable secret in screenshots).

## 3. Mobile delivery: Expo vs web app

**Decision**: **Mobile web** (`apps/mobile` Vite + React), not Expo. Phone browser / add-to-home-screen. Talks to same Next API with CORS already used by the extension origin pattern (mobile origin allowlisted or same-site via reverse proxy in deploy).

**Rationale**: User + spec require web companion; tech-stack “Expo later” stays future.

**Alternatives considered**: Expo (heavier, store path); only `apps/web/app/m/*` (acceptable fallback if monorepo cost bites—plan prefers `apps/mobile`).

## 4. First slice vs agents/voice

**Decision**: Implement and validate **pair → directory → chat** before agents UI and ElevenLabs. Agents reuse existing action/agent HTTP once 010 exists; if 010 absent, stub “unavailable” rather than blocking chat. Voice is tap-to-listen TTS (+ optional STT) behind an adapter; missing key → hide controls.

**Rationale**: Clarify answer B; SC-007 optional when voice configured.

## 5. Device cap

**Decision**: Enforce max **3** non-revoked `kind=mobile` devices per user; creating a fourth returns a clear error asking to revoke. Extension devices are separate and not counted in that cap (or count 1 extension + 3 mobile—prefer: cap applies to mobile only).

**Rationale**: Clarify deferred default; prevents token sprawl.

## 6. QR contents

**Decision**: QR encodes an HTTPS URL to the mobile companion pair route with the code as a query param (e.g. `https://<mobile-origin>/pair?code=ABCD`). User can also type the code. Desktop shows both.

**Rationale**: Phone cameras open URLs; no custom scheme required for MVP.

## 7. ElevenLabs

**Decision**: Preferred TTS via ElevenLabs server route (API key server-side); client plays audio. STT: browser Web Speech or ElevenLabs if time. Pivot: skip voice UI or Web Speech TTS only.

**Rationale**: Constitution stack pivots; FR-014/FR-015.
