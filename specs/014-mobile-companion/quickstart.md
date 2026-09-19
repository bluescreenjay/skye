# Quickstart: Validate Mobile Companion

Use after 014 is implemented. Validates [pairing.md](contracts/pairing.md) and [mobile-ui.md](contracts/mobile-ui.md).

## Prerequisites

- Node 22+, pnpm 9; Postgres migrated through `014_mobile_devices.sql`.
- `pnpm --filter @ai-browser/web dev` and mobile app (or static) reachable from the phone (same LAN URL or tunnel).
- Extension loaded with paired desktop token; Home can call create-offer.
- Optional: `ELEVENLABS_API_KEY` for voice checks (skip if unset).

## Build / run

```bash
pnpm install
pnpm typecheck
pnpm --filter @ai-browser/web test
pnpm --filter @ai-browser/web dev
# mobile (name may match package):
pnpm --filter @ai-browser/mobile dev
pnpm --filter @ai-browser/extension build
```

Point mobile env at the API base URL. Reload extension after build.

## Walkthrough (first slice)

1. **Create offer**: On Home, start pair phone. Note code + QR; confirm ~5 min expiry UI.
2. **Redeem**: On phone, open companion `/pair` (or scan QR). Complete redeem; token stored; land on directory.
3. **Directory**: Workspaces match desktop names; open one; pages match.
4. **Chat**: Send a message on phone; reload desktop Home/chat for that workspace — history matches. Reverse also.
5. **Expiry**: Create offer, wait past expiry (or manipulate clock in tests); redeem fails clearly.
6. **Revoke**: From Home, revoke the phone device; phone refresh gets unpaired; chat/list fail closed.
7. **Cap** (optional): Pair 3 mobiles; fourth redeem rejected until revoke.

## Later in feature

8. **Agents**: If 010 present, run one agent from mobile; result visible on desktop.
9. **Voice**: With ElevenLabs configured, tap-to-listen on a reply within ~10 s; without key, chat still works.

## Completion checks

- Legacy extension token still authenticates (compat).
- No Chrome tab mutations from mobile.
- Checklist: pair + directory + chat green before agents/voice polish.
