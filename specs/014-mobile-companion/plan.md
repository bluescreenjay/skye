# Implementation Plan: Mobile Companion

**Branch**: `014-mobile-companion` | **Date**: 2026-09-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/014-mobile-companion/spec.md`

## Summary

Ship a **mobile web companion** that shares the same durable workspaces as the Chrome extension. Desktop Home starts a **~5 minute, single-use QR/code pairing offer**; the phone redeems it and receives a **durable per-device Bearer token** for the same `user_id`. First shippable slice: **pair + directory + workspace chat**. Agents and light ElevenLabs voice (tap-to-listen / optional speak-to-ask) follow later in the same feature without blocking that slice. Mobile never controls Chrome tabs.

Design detail: [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), validation: [quickstart.md](./quickstart.md).

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22+, pnpm monorepo; Next.js App Router (`apps/web`); mobile UI as a small React + Vite app (`apps/mobile`) or equivalent mobile-first routes—see research.

**Primary Dependencies**: Existing `@ai-browser/shared`, `apps/web` auth + workspace/chat routes; Chrome extension Home for pairing UI; ElevenLabs (preferred) or Web Speech pivot for P3 voice.

**Storage**: Tiger/Postgres. New migration for **devices** (multi-token) and **pairing_offers**; keep existing `users.device_token_hash` working via auth lookup compatibility (research).

**Testing**: `tsc --noEmit`; Vitest (web: pairing redeem/revoke + auth multi-device; mobile: light unit tests); manual phone viewport + QR/code walkthrough in quickstart.

**Target Platform**: Local/Vultr Next API; mobile Safari/Chrome; extension Home on desktop Chrome.

**Project Type**: Stretch companion = mobile web client + API pairing/device endpoints + Home pairing chrome; not a native store app.

**Performance Goals**: Pairing under 2 minutes (SC-001); chat first words same class as 008; voice reply audio under 10 s when configured (SC-007).

**Constraints**: User-scoped everything; offers expire ~5 min and single-use; ≤3 active mobile devices; revoke kills access; no tab control from phone; voice never blocks text path; secrets server-side only.

**Scale/Scope**: Demo: one person, desktop + 1–2 phones; directory + chat first; agents/voice incremental.

## Constitution Check

*GATE: Must pass before Phase 0. Re-check after Phase 1.*

| Principle | Status | How this plan complies |
| --- | --- | --- |
| I. Workspace-First | PASS | Mobile is another view of the same workspaces/chat; no mobile-only catalog. |
| II. Extension observes / server decides | PASS | Pairing, tokens, chat, agents stay on the server; mobile and Home only call HTTP. Extension still owns Chrome. |
| III. User corrections win | PASS | Mobile does not reassign tabs (FR-012). |
| IV. Least-power actions | PASS | Reuse existing chat/agent routes; pairing is a thin ceremony; no computer-use. |
| V. One TypeScript surface | PASS | Shared types for Device / PairingOffer in `@ai-browser/shared`; mobile uses same Workspace/Message shapes. |
| VI. Demo-hard, architecture-soft | PASS | Stretch feature; first slice is pair+list+chat; ElevenLabs behind adapter with Web Speech/skip pivot. |
| VII. Two surfaces | PASS* | Home + Sidebar remain the desktop pair; mobile is an explicit stretch third surface (FEATURES 014), not a Side Panel clone. |
| Persistence / secrets | PASS | Device tokens hashed like today; pairing codes hashed + TTL; no keys in the mobile bundle. |

\*Justified stretch surface—see Complexity Tracking.

**Gate result: PASS** (with noted stretch surface).

## Project Structure

### Documentation (this feature)

```text
specs/014-mobile-companion/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── pairing.md
│   └── mobile-ui.md
└── tasks.md                 # /speckit-tasks (not this command)
```

### Source Code (repository root)

```text
packages/shared/
  sql/014_mobile_devices.sql     # devices + pairing_offers
  src/…                          # Device, PairingOffer types if needed

apps/web/
  app/api/pairing/…              # create / redeem / (status)
  app/api/devices/…              # list + revoke for the person
  src/auth.ts                    # resolve Bearer via devices (+ legacy user token)

apps/extension/
  src/home/…                     # pairing panel: code + QR, device list/revoke

apps/mobile/                     # mobile web companion (Vite React)
  src/…                          # pair, directory, workspace chat; later agents/voice
```

**Structure Decision**: New `apps/mobile` web app talking to existing `apps/web` API (separate UX entry, same backend). Pairing + device APIs live in `apps/web`. Home hosts the desktop half of pairing. Avoid Expo for this feature (spec: mobile web).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| Third product surface (mobile web) beyond Home + Sidebar | FEATURES 014 / stretch companion | Embedding only in Side Panel cannot serve phone away from desk |
| `apps/mobile` package | Spec requires separate mobile web experience | Only `/m` routes on `apps/web` works but couples deploy/UX; separate app keeps mobile CSS/nav isolated |
