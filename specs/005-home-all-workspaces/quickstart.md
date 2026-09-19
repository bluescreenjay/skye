# Quickstart: Home — all workspaces

Proves toolbar Home matches the mock layout and talks to 003 — without new-tab takeover or dummy seed data.

## Prerequisites

- 003 API running: `pnpm --filter @ai-browser/web dev` (`http://127.0.0.1:3000`)
- Schema applied; `DEVICE_TOKEN_SECRET` set in repo-root `.env`
- `apps/extension/.env`:

```bash
VITE_API_BASE_URL=http://127.0.0.1:3000
VITE_DEVICE_TOKEN=home-token-aaaaaaaa
```

Same token as ingest / pairing.

## Seed (optional)

If clustering is not ready, create two workspaces and a few tab refs with curls from `specs/003-workspace-persistence-api/quickstart.md` (include at least one `workspaceId: null` Other tab). Home has **no** create button.

## Build and load

```bash
pnpm --filter @ai-browser/extension build
```

Chrome → Extensions → Load unpacked → `apps/extension/dist`.

## Checks

1. **New tab** (Ctrl/Cmd+T) is still Chrome’s default, not Home.
2. Click the **toolbar icon** → Home opens: photo background, rail, “skye”, url field, greeting, cards.
3. Side-by-side with `specs/005-home-all-workspaces/mocks/home-design-prototype/index.html` (Home view): same structure (not the workspace panel).
4. Named workspaces appear as cards **and** rail tiles; Other tabs as rail-top icons.
5. Expand one card → three columns; expand another → first collapses.
6. Rename a card → reload Home → name remains.
7. Drag a tab to the ungrouped rail → it stays Other after reload.
8. Click a tab row → that URL opens in a **new** browser tab; Home tab still shows Home.
9. Disconnect API or use a bad token → Home chrome remains, **no** “refs — furniture” dummy cards.
10. Allow location → greeting mentions weather; deny → greeting still shows with a short fallback.

## Fail if

- `chrome_url_overrides` is in the manifest
- Side Panel UI is present
- Home is only a Next.js `apps/web` page
- Mock dummy workspaces appear as live data
- Layout was redesigned in Tailwind/bento instead of the prototype

Contracts: [home-ui.md](./contracts/home-ui.md), [extension-home.md](./contracts/extension-home.md)
