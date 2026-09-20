# @ai-browser/extension

Chrome (Manifest V3) extension that **observes** your tabs, reports them to the AI Browser
backend, opens **Home** — the all-workspaces directory — from the toolbar icon, and shows
the active tab's workspace in Chrome's Side Panel.

It never moves, groups, or closes a Chrome tab, decides workspaces, or runs AI. Home can
rename workspaces and reassign saved tab refs through the API; clicking a tab opens that
URL in a new browser tab and leaves Home open.

## Home

Click the toolbar icon. Home is an extension page (`home.html`), not Chrome’s new-tab page
and not a popup. A normal Ctrl/Cmd+T stays the browser default.

## Sidebar

On a normal web page, open Chrome's Side Panel picker and select **AI Browser**. The panel
shows the active tab's saved workspace or Other, plus saved related pages. Switching tabs
retargets the panel; selecting a related page opens it in a normal browser tab. Plan,
suggested-action, and chat areas are placeholders until later features. Closing the panel
does not change a workspace or its tab assignments. The toolbar icon still opens Home.
Activating Home (or the panel's **home** control) closes the Side Panel; it stays disabled
while Home is the active tab.

The panel chrome follows `design_mockup/` (home control, wordmark, address, member list,
dock) with Home's accent/type tokens. From the Side Panel you can move the active page to
another workspace or dismiss it to Other; both call the same membership PATCH as Home.
Plan, suggested-action, and chat areas remain placeholders until later features. The
panel uses the same `VITE_API_BASE_URL` and `VITE_DEVICE_TOKEN` as Home. If pairing or the
server is unavailable, it shows a quiet status rather than another tab's workspace.

Layout matches `specs/005-home-all-workspaces/mocks/home-design-prototype/` (Home view only):
photo, rail, “skye”, url field, greeting, workspace cards. Other tabs are rail-top icons, never
a named “other” card. There is no create-workspace control and no Chrome tab-group sync
(those are stretch — see FEATURES). Drag a tab onto another workspace (or Other) to move it;
renaming a card title updates the workspace name via the API. Archive a workspace with the
card × (live tabs move to Other); closing the last live tab archives it automatically.

**Organize** (feature 005b) posts to `POST /api/cluster/runs` with the same device token, then
reloads workspaces and tab-refs so new groups appear. Home never invents workspace names or runs
Gemini itself. The API needs `GEMINI_API_KEY` (see repo-root `.env`). Walkthrough:
`specs/005b-home-run-clustering/quickstart.md`.

Walkthrough (directory only): `specs/005-home-all-workspaces/quickstart.md`.

## What it reports (ingest)

- A snapshot of every open web page (`http`/`https`) when it starts, and again after a gap in delivery.
- A timestamped event for each tab that is opened, updated (address or title), activated, or closed.
- Which tab is in front in the focused window, and a short plain-text excerpt (up to 2000 characters) of each page.

Updates wait about 2 seconds for a tab to settle (30 seconds at most for a tab that never does);
opens, closes, and activations go out immediately. If the backend is unreachable the events are
kept for at least 24 hours and delivered in order, once each, when it comes back.

**Never reported:** incognito windows, `chrome://` and extension pages, `file:` and other non-web schemes.

> **Known limitation.** There is no pause switch or site exclusion list yet. A page on a sensitive
> site in a normal window (banking, mail) is reported, snippet included, to *your* backend like any
> other. Chrome will also warn that the extension can "read and change all your data on all websites":
> that permission is what lets it read a page's address, title, and text.

## Setup

```bash
cp apps/extension/.env.example apps/extension/.env   # copy, do not rename
# edit apps/extension/.env:
#   VITE_API_BASE_URL=http://127.0.0.1:3000     (real API; Home and ingest)
#   VITE_DEVICE_TOKEN=dev-token                 (same token for pairing)
```

For ingest-only against the stub receiver, `VITE_API_BASE_URL=http://localhost:8787` still works;
Home will show empty chrome because the stub is not the 003 API.

Start the real API (`pnpm --filter @ai-browser/web dev`, with `DATABASE_URL` and
`DEVICE_TOKEN_SECRET` in the repo-root `.env`), set `VITE_API_BASE_URL=http://127.0.0.1:3000` and a
token of at least 8 characters, then rebuild and reload. The API creates the user the first time it
sees the token, so keep the same token: a different one is a different, empty account.

The values are read at build time and baked into the extension, so **`dist/` contains the token:
never commit or share it**, and never commit `.env`. There is no settings screen; to point at a
different backend, change `.env` and rebuild.

## Run

```bash
pnpm --filter @ai-browser/web dev           # 003 API on :3000 (needed for Home)
pnpm --filter @ai-browser/extension stub    # optional stand-in ingest receiver on :8787
pnpm --filter @ai-browser/extension build   # writes apps/extension/dist
```

Then open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select `apps/extension/dist`.
Click the toolbar icon for Home. Stub flags: `--port`, `--token`, `--fail 500|401|slow` (see the header of `scripts/stub-receiver.mjs`).

Other scripts: `test` (Vitest) and `typecheck`. If `pnpm` is not installed, use `npx -y pnpm@9 …`.

## The toolbar badge

Same icon that opens Home. Nothing is shown on the badge while ingest is fine.

| Badge | Meaning |
| --- | --- |
| `…` | The backend is not answering; events are kept and retried with growing delays. |
| `!` (red) | The backend rejected the device token, or `.env` is missing or invalid. Nothing is dropped. Fix `.env`, rebuild, and reload the extension. |

## Layout

| File | Role |
| --- | --- |
| `home.html`, `src/home/` | Home directory page (toolbar). Mock CSS, 003 API client, weather. |
| `sidepanel.html`, `src/sidebar/` | In-tab workspace panel: active-page context, saved members, future tool areas. |
| `src/ui/` | Tab marks and rows shared by Home and Sidebar. |
| `src/background.ts` | Service worker: ingest listeners plus `action.onClicked` → Home. |
| `src/collector.ts` | Chrome tab events → queued events and pending snapshots (the 2 s settle and 30 s cap). |
| `src/snapshot.ts` | Full snapshots, browser-start reset, and the active-tab sample. |
| `src/snippet.ts` | Reads a page's text; decides when to read and when to reuse. |
| `src/sender.ts` | Batched delivery, retry and backoff, credential and invalid-request handling. |
| `src/store.ts` | Everything durable, in `chrome.storage.local` (the worker can stop at any time). |
| `src/heartbeat.ts` | The 30-second tick and the reset at install and browser start. |
| `src/filters.ts`, `config.ts`, `status.ts` | Eligibility rules, build-time config, the badge. |

## More

- Home spec and validation walkthrough: `specs/005-home-all-workspaces/` (`quickstart.md`).
- Ingest spec: `specs/002-tab-ingestion-extension/` (`quickstart.md` against the stub).
- The HTTP contract the backend (feature 003) must implement: `specs/002-tab-ingestion-extension/contracts/ingest-api.md`.
- Wire types are shared with the server through `@ai-browser/shared`.
