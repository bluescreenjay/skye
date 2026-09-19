# Quickstart: Tab Ingestion Extension (002)

Validates the extension end to end against a local stand-in receiver. No database, Tiger account, or AI key is needed. Feature 003 later replaces the stub with the real API.

## Prerequisites

- Node.js 22+, pnpm 9+ (`npx -y pnpm@9 …` works if pnpm is not installed), a recent desktop Chrome
- Feature 001 in place (`pnpm install` works, `@ai-browser/shared` typechecks)

## Setup

```bash
pnpm install
cp apps/extension/.env.example apps/extension/.env   # copy, do not rename
# edit apps/extension/.env:
#   VITE_API_BASE_URL=http://localhost:8787
#   VITE_DEVICE_TOKEN=dev-token
```

## Run

```bash
# terminal A: the stand-in receiver (logs every batch, checks the token, dedupes event ids)
pnpm --filter @ai-browser/extension stub
#   flags: --port 8787  --token dev-token  --fail 500|401|slow  (see the script header)

# terminal B: build the extension
pnpm --filter @ai-browser/extension build
```

Then in Chrome: `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → choose `apps/extension/dist`.

## Automated checks

```bash
pnpm -r typecheck                              # shared + web + extension compile
pnpm --filter @ai-browser/extension test       # eligibility, snippet, coalescing, queue, retry logic
pnpm --filter @ai-browser/extension build      # produces dist/ with a valid manifest
```

## Validate (manual, against the stub)

| # | Do this | Expect | Covers |
| --- | --- | --- | --- |
| V1 | Open 5+ web tabs across two windows, then load the extension | Stub logs one `fullSnapshot: true` request listing every open `http(s)` tab with url, title, `chromeTabId`, `windowId` | FR-001, FR-010, SC-002 |
| V2 | Open a tab, navigate it, close another | One event each for `opened`, `updated`, `closed`, with times and unique ids; the stub's delay log shows at least 95% of events received within 5 s | FR-002, SC-001 |
| V3 | Switch tabs; focus the other window | `activated` events; `active` in the request points at the front tab; moving to a `chrome://` page makes `active.chromeTabId` `null` | FR-003 |
| V4 | Open an article, a `chrome://settings` page, and a nearly empty page | Article has a snippet ≤ 2000 chars of plain text; the settings page never appears; the empty page is reported with `"snippet": ""` | FR-004, FR-005, FR-013 |
| V5 | Load a page whose title keeps changing, or click through redirects | One `updated` about 2 seconds after the last change, carrying the final state; a tab that never settles still reports within about 30 seconds | FR-009 |
| V6 | Stop the stub, browse for several minutes (open, navigate, close), restart the stub | After recovery (once the current retry delay has passed: at most 5 minutes after a long outage; reloading the extension skips the wait) every event arrives **once**, in order, with `duplicates: 0`; the tab list matches the browser | FR-007, FR-008, SC-003 |
| V7 | With the stub stopped, make changes, quit Chrome fully, reopen it, start the stub | The backlog is delivered, followed by a `fullSnapshot: true` request | FR-007, FR-010, SC-004 |
| V8 | Run the stub with `--fail 401` and change some tabs | Nothing dropped, no tight retry loop, badge shows `!`; restart the stub without the flag, then reload the extension at `chrome://extensions` (or restart Chrome): sending stays stopped until then, and afterwards the backlog delivers, led by a `fullSnapshot: true` request | FR-011 |
| V9 | Open an incognito window, browse in it; repeat with "Allow in incognito" on for the extension | Nothing from the window reaches the stub in either case | FR-013, SC-005 |
| V10 | Browse normally for a session | The extension moves, groups, renames, and closes no tabs; `dist/manifest.json` has none of the forbidden keys in `contracts/extension-config.md` | FR-014, FR-016, SC-008 |
| V11 | Open 100 tabs | Browsing feels normal and the extension's worker CPU stays low in Chrome's Task Manager (Shift+Esc); the stub log shows the initial snapshot within 15 s | SC-002, SC-006 |
| V12 | Leave the browser idle for over a minute, then change a tab | The change is still delivered (the worker restarted or stayed alive) | research §3 |

### Open questions from research (check these once)

1. **Alarm restarts a stopped worker.** Open `chrome://serviceworker-internals`, stop the extension's worker, wait one heartbeat (about 30 s), and confirm it starts again and drains the backlog.
2. **Host permission covers localhost.** V1 passing against `http://localhost:8787` confirms `http://*/*` allows it; if the request fails with a permission error, add the API origin to `host_permissions` explicitly.
3. **`incognito: "not_allowed"`.** V9 confirms the behavior; the code also checks `tab.incognito`.

## Spot-check contracts

- Wire format and server obligations: [contracts/ingest-api.md](./contracts/ingest-api.md)
- Shared types: [contracts/shared-ingest-types.md](./contracts/shared-ingest-types.md)
- Config and manifest: [contracts/extension-config.md](./contracts/extension-config.md)
- Persisted state and rules: [data-model.md](./data-model.md)

## Done when

All V-rows pass and the automated checks are green. Full server-visible records (rows in the database) are confirmed after feature 003.

## Fail if

- Any record from an incognito window or a `chrome://` / extension page reaches the stub
- Events are lost, duplicated, or out of order after an outage or browser restart
- The extension redefines `TabRef` or `TabEvent` locally instead of importing from `@ai-browser/shared`
- A real token or `apps/extension/.env` is committed, or `dist/` is committed
- Home, a side panel, a settings page, or any tab-moving behavior is added
