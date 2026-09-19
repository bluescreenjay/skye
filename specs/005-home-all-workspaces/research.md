# Research: Home — all workspaces

## 1. Where Home runs

- **Decision**: Full Chrome **extension page** (`home.html` in `apps/extension`). Toolbar `chrome.action.onClicked` runs `chrome.tabs.create({ url: chrome.runtime.getURL("home.html") })`. No `default_popup` (too small). No `chrome_url_overrides.newtab`.
- **Rationale**: Clarify Q5. 002 already uses `action` for a badge with no popup; `onClicked` is valid when popup is absent. Ingest keeps running in the service worker.
- **Alternatives considered**: New-tab override (constitution default; rejected for 005). Popup (cannot match mock). Host Home on Next.js (wrong surface; constitution: extension presents Home).

## 2. Visual implementation

- **Decision**: Copy the mock’s **Home** CSS (and `main_background.jpg`) into the extension. React components emit the **same DOM/class names** as `app.js` `renderHome` / `renderRail` (home view only). Do not convert to Tailwind utilities in this feature. Do not ship `data-view="workspace"` UI.
- **Rationale**: Spec visual source of truth is the running prototype. Tailwind would be a redesign.
- **Alternatives considered**: iframe the static HTML (cannot bind to 003 without a messy bridge). Vanilla port of `app.js` (works, but Principle V wants shared React with Sidebar later).

## 3. Data loading

- **Decision**: On Home mount: `GET /api/workspaces` and `GET /api/tab-refs` with `Authorization: Bearer` from existing `VITE_DEVICE_TOKEN`. Compose: Other = `workspaceId == null`; each workspace card = workspace + its tab refs. Empty arrays if 401/network/misconfigured — **never** import dummy names from the mock.
- **Rationale**: FR-008, FR-009, clarify Q4. 003 already has these routes. Optional `POST /api/session` once if a 401 might mean “not paired yet” but the same token is used for ingest; if ingest already paired, GET is enough. If 401, show empty chrome (do not invent users in the UI).
- **Alternatives considered**: Read only `chrome.tabs` (would ignore persistence). Seed mock JSON (forbidden).

## 4. Mutations

- **Decision**: Rename → `PATCH /api/workspaces/:id` `{ name }` (lowercase trim, 1–80). Drag → `PATCH /api/tab-refs/:id` `{ workspaceId: uuid \| null }`. No `POST /api/workspaces` from Home.
- **Rationale**: Clarify Q3. 007 will add create + Chrome tab-group sync.
- **Alternatives considered**: Optimistic-only local state (would diverge from server). PUT upsert (overkill for a move).

## 5. Opening a page

- **Decision**: Click icon/row → `chrome.tabs.create({ url: tabRef.url })`. Home tab stays. Ignore click if the event was a drag. Do not `window.location` into the mock workspace view.
- **Rationale**: Clarify Q1.
- **Alternatives considered**: `chrome.tabs.update` current (would leave Home). Side Panel (006).

## 6. Greeting / weather

- **Decision**: After first paint, `navigator.geolocation.getCurrentPosition` (timeout ~4s). Then Open-Meteo `forecast?latitude=&longitude=&current=temperature_2m,weather_code&temperature_unit=fahrenheit`. Map codes to the mock’s short phrases. On deny/error: `"hard to tell"`. Time via `toLocaleTimeString` lowercase. Work hint from up to three workspace names.
- **Rationale**: Clarify Q2; mock already does this. Weather must not block render.
- **Alternatives considered**: No weather (rejected). Fixed city (rejected). Gemini for greeting (out of scope).

## 7. Icons

- **Decision**: Do not require the missing `icons/*.png` pack. Draw small colored marks from a restrained palette keyed by hostname (or title initial), matching the mock’s “letter on color” look.
- **Rationale**: Prototype referenced files that were not in the drop. Fake brand favicons look like the anti-AI list.
- **Alternatives considered**: Live Google S2 favicons (inconsistent, extra network). Commit a large icon zip (not provided).

## 8. Toolbar vs ingest badge

- **Decision**: Keep 002 badge on the same `action`. Click still opens Home. `default_title` can mention Home (e.g. “skye home”).
- **Rationale**: One icon. Badge is status, not a second launcher.
- **Alternatives considered**: Separate Home action (Chrome allows only one `action`).

## 9. React in the extension

- **Decision**: Add `react` / `react-dom` to `apps/extension` for Home. CRXJS + Vite already build extra HTML entries.
- **Rationale**: Constitution UI is React; Sidebar will need the same. Home CSS stays mock-based so we do not wait on a design system.
- **Alternatives considered**: Preact (extra mental model). Stay vanilla (harder to share with 006).

## Clarifications

None remaining from Technical Context. New-tab override and Tailwind are explicit deferred/exceptions in `plan.md`.
