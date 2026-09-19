# Implementation Plan: Home — all workspaces

**Branch**: `005-home-all-workspaces` | **Date**: 2026-09-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-home-all-workspaces/spec.md`

## Summary

Ship the **Home directory** as a full Chrome extension page that matches the Home view of `specs/005-home-all-workspaces/mocks/home-design-prototype/` (layout, type, color, density). Open it from the **toolbar icon** only — do **not** take over Chrome’s new-tab page. Read workspaces and Other from the 003 API with the same `VITE_DEVICE_TOKEN` as ingest. Rename and drag persist via PATCH. Clicking a tab opens that URL in a normal browser tab; Home stays open. No Side Panel, no create-workspace control, no dummy furniture data.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Chrome MV3 extension pages + existing service worker

**Primary Dependencies**: Existing Vite + CRXJS; `@ai-browser/shared`; React 19 in `apps/extension` so Home (and later Sidebar) share one UI surface. **CSS is the mock’s stylesheet**, not Tailwind — visual fidelity beats a utility rewrite.

**Storage**: None new. Directory data is 003 Postgres via HTTP. Pairing token is already build-time `VITE_DEVICE_TOKEN`. Greeting weather is ephemeral (Open-Meteo + geolocation); not stored.

**Testing**: `pnpm --filter @ai-browser/extension typecheck`; Vitest for grouping/membership helpers and “no dummy seed” guards; visual check against the mock (quickstart). No Playwright required.

**Target Platform**: Chrome desktop, unpacked `apps/extension/dist`. API at `VITE_API_BASE_URL` (local Next `http://127.0.0.1:3000`).

**Project Type**: Extension UI (monorepo `apps/extension`) consuming `apps/web` APIs

**Performance Goals**: Home usable within 10 seconds of toolbar click (SC-001); weather must not block first paint.

**Constraints**: Same `userId` as ingest (Bearer token). No `chrome_url_overrides`. No Side Panel. No create-workspace UI. Real API data only. Accordion: one expanded card. Copy lowercase. Mock CSS class names / metrics preserved.

**Scale/Scope**: One Home page: rail + greeting + workspace cards. Stub actions/ask/artifacts regions. Drag + rename + open URL.

## Constitution Check

*GATE: Must pass before Phase 0. Re-check after Phase 1.*

| Principle | Status | How this plan complies |
| --- | --- | --- |
| I. Workspace-First | PASS | Cards are durable workspaces; empty workspaces still list; Other is rail icons, not a fake named card. |
| II. Extension presents; server decides | PASS | Home is extension UI; membership and names persist through 003; no clustering in the client. |
| III. User corrections win | PASS | Rename and drag update the server. Create-workspace deferred (later feature) per clarify. |
| IV. Least-power | PASS | `fetch` + `chrome.tabs.create` + Open-Meteo. No agents. Actions/ask are stubs. |
| V. One TypeScript surface | PASS | React+TS Home using `@ai-browser/shared`. Mock CSS instead of a second visual system. |
| VI. Demo-hard | PASS | Toolbar Home + existing API. Clustering optional. Weather failure does not block. |
| VII. Two surfaces | EXCEPTION | Home exists as the directory. **Clarification Q5:** do not take over new-tab in 005. Toolbar opens Home. New-tab override is a later, explicit change — not forgotten. Sidebar still out of scope. |
| Secrets | PASS | Reuse gitignored `apps/extension/.env`; do not log the device token. |
| Stack | EXCEPTION | Constitution lists Tailwind for web UI. **Home uses the mock CSS** so layout matches. Path back: shared tokens later; do not rewrite Home into Tailwind this feature. |

**Gate result: PASS with documented exceptions** (new-tab deferred; mock CSS over Tailwind). See Complexity Tracking.

**Post-design re-check:** Unchanged. Contracts do not add Side Panel or `chrome_url_overrides`.

## Project Structure

### Documentation (this feature)

```text
specs/005-home-all-workspaces/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── home-ui.md
│   └── extension-home.md
├── mocks/home-design-prototype/   # visual source of truth
└── tasks.md                       # /speckit-tasks later
```

### Source Code (repository root)

```text
apps/extension/
├── home.html                         # NEW: extension page (toolbar opens this)
├── src/home/
│   ├── main.tsx                      # React mount, Home view only
│   ├── Home.tsx                      # rail + greeting + cards (mock class names)
│   ├── api.ts                        # GET/PATCH workspaces + tab-refs
│   ├── weather.ts                    # geolocation + Open-Meteo, fallback phrase
│   ├── icons.ts                      # colored letter marks (no dummy brand pack required)
│   └── home.css                      # copy of mock Home CSS (+ background asset)
├── src/background.ts                 # CHANGED: action.onClicked → open home.html tab
├── manifest.config.ts                # CHANGED: action title; still no popup; no chrome_url_overrides
├── vite.config.ts                    # CHANGED: include home.html in CRXJS build if needed
└── tests/home-*.test.ts              # grouping, drag mapping, no dummy seed
apps/web/                             # unchanged API
specs/005-.../mocks/home-design-prototype/
└── main_background.jpg               # copy or import into extension public/home/
```

**Structure Decision**: Home lives in `apps/extension` as an extension page, not in `apps/web`. Next.js `page.tsx` stays the API shell. Do not port the mock’s workspace/page view.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| No new-tab override (VII wording) | Spec clarify Q5: toolbar only | New-tab takeover is a bigger install behavior change than 005 needs |
| Mock CSS instead of Tailwind | Spec: layout must match the prototype | Tailwind rewrite would drift from the mock |

## Next

`/speckit-tasks` then `/speckit-implement`.
