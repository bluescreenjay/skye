# @ai-browser/extension

Chrome (Manifest V3) extension that **observes** your tabs and reports them to the AI Browser
backend. It has no workspace UI: Home (feature 005) and the Sidebar (feature 006) come later.
It never moves, groups, renames, or closes a tab, decides workspaces, or runs AI.

## What it reports

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
#   VITE_API_BASE_URL=http://localhost:8787     (the stub receiver, below)
#   VITE_DEVICE_TOKEN=dev-token
```

To send to the real API instead of the stub, start it (`pnpm --filter @ai-browser/web dev`, with `DATABASE_URL` and
`DEVICE_TOKEN_SECRET` in the repo-root `.env`), set `VITE_API_BASE_URL=http://localhost:3000` and a token of at least 8
characters, then rebuild and reload. The API creates the user the first time it sees the token, so keep the same token:
a different one is a different, empty account. Read the result with `GET /api/tab-refs` and `GET /api/tab-events`
using `Authorization: Bearer <your token>`.

The values are read at build time and baked into the extension, so **`dist/` contains the token:
never commit or share it**, and never commit `.env`. There is no settings screen; to point at a
different backend, change `.env` and rebuild.

## Run

```bash
pnpm --filter @ai-browser/extension stub    # stand-in backend on :8787; logs every batch and how late each event arrived
pnpm --filter @ai-browser/extension build   # writes apps/extension/dist
```

Then open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select `apps/extension/dist`.
Stub flags: `--port`, `--token`, `--fail 500|401|slow` (see the header of `scripts/stub-receiver.mjs`).

Other scripts: `test` (Vitest) and `typecheck`. If `pnpm` is not installed, use `npx -y pnpm@9 …`.

## The toolbar badge

The only visible surface. Nothing is shown while everything is fine.

| Badge | Meaning |
| --- | --- |
| `…` | The backend is not answering; events are kept and retried with growing delays. |
| `!` (red) | The backend rejected the device token, or `.env` is missing or invalid. Nothing is dropped. Fix `.env`, rebuild, and reload the extension. |

## Layout

| File | Role |
| --- | --- |
| `src/background.ts` | Service worker: registers every listener and wires the modules. Nothing else. |
| `src/collector.ts` | Chrome tab events → queued events and pending snapshots (the 2 s settle and 30 s cap). |
| `src/snapshot.ts` | Full snapshots, browser-start reset, and the active-tab sample. |
| `src/snippet.ts` | Reads a page's text; decides when to read and when to reuse. |
| `src/sender.ts` | Batched delivery, retry and backoff, credential and invalid-request handling. |
| `src/store.ts` | Everything durable, in `chrome.storage.local` (the worker can stop at any time). |
| `src/heartbeat.ts` | The 30-second tick and the reset at install and browser start. |
| `src/filters.ts`, `config.ts`, `status.ts` | Eligibility rules, build-time config, the badge. |

## More

- Spec, plan, contracts, and the validation walkthrough: `specs/002-tab-ingestion-extension/`
  (`quickstart.md` is the step-by-step checklist to run against the stub).
- The HTTP contract the backend (feature 003) must implement: `specs/002-tab-ingestion-extension/contracts/ingest-api.md`.
- Wire types are shared with the server through `@ai-browser/shared`.
