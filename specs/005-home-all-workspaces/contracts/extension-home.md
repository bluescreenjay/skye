# Contract: extension wiring for Home

## Manifest (`apps/extension/manifest.config.ts`)

| Key | 005 value |
| --- | --- |
| `action` | Keep a toolbar action. **No** `default_popup`. Title may say Home. |
| `chrome_url_overrides` | **Forbidden** in this feature |
| `side_panel` / `sidePanel` | **Forbidden** |
| Existing 002 keys | Keep: `background`, `storage`, `alarms`, `scripting`, `host_permissions`, `incognito: not_allowed` |

Home is an extension HTML page included in the CRXJS build (`home.html`). It is opened by URL `chrome.runtime.getURL("home.html")`.

## Service worker

On `chrome.action.onClicked`: open Home in a **new tab** (reuse an existing Home tab if already open is allowed but not required). Do not steal the current web tab.

002 badge behavior stays: retrying `…`, auth/misconfigured `!`.

## Config

Reuse `VITE_API_BASE_URL` and `VITE_DEVICE_TOKEN` from `apps/extension/.env` (see 002). If either is empty, Home still renders chrome and loads no directory rows (same as misconfigured ingest). Do not log the token.

## API (003)

Base: `{VITE_API_BASE_URL}`. Header: `Authorization: Bearer {VITE_DEVICE_TOKEN}`.

| Call | When |
| --- | --- |
| `GET /api/workspaces` | Load cards/tiles (default hides archived) |
| `GET /api/tab-refs` | Load Other + membership |
| `PATCH /api/workspaces/:id` `{ "name" }` | Inline rename |
| `PATCH /api/tab-refs/:id` `{ "workspaceId": uuid \| null }` | Drag |

Do not call `POST /api/workspaces` from Home. Click-open uses `chrome.tabs.create`, not the API.

Errors: 401/5xx/network → empty directory, keep layout. Never seed mock JSON.

## Weather

Browser geolocation on the Home page + Open-Meteo HTTPS. Timeout and fallback phrase required. Not an extension `geolocation` permission if the page API suffices; if Chrome blocks it on extension pages, add the documented permission rather than drop weather (spec requires location when allowed).

## Out of scope

Side Panel, new-tab override, live url-bar navigation, clustering, persisted chat/artifacts, Chrome tab-group sync.
