# Research: Tab Ingestion Extension

Facts marked **(docs)** were checked against Chrome's current extension documentation on 2026-09-19. Anything not so marked is a design choice, and the ones I could not confirm from the docs are listed under **Verify empirically** at the end and turned into quickstart checks.

## 1. Build tooling

- **Decision**: Vite 7 + `@crxjs/vite-plugin` 2.7 (both already installed by feature 001), with a `vite.config.ts` and a static `manifest.config.ts` using `defineManifest` (nothing in the manifest depends on the environment). Build with `vite build` and load the `dist/` folder unpacked.
- **Rationale**: Constitution stack row for the extension. CRXJS declares Vite 3–8 as peers; Vite 7.3 is installed and known to resolve. `manifest.config.ts` already exists from 001. A plain `build` then load-unpacked is deterministic; HMR dev mode is optional.
- **Alternatives considered**: Plasmo or WXT (allowed pivots, but a second framework to learn for a background-only extension); Vite 8 (peer-compatible but newer, no need); hand-written `manifest.json` plus esbuild (loses the typed manifest already in place).

## 2. Permissions and manifest shape

- **Decision**: `permissions: ["storage", "alarms", "scripting"]`; `host_permissions: ["http://*/*", "https://*/*"]`; `incognito: "not_allowed"`; a bare `action` (title only, no popup) for the status badge. No `tabs`, `activeTab`, `<all_urls>`, `chrome_url_overrides`, `side_panel`, or `unlimitedStorage`.
- **Rationale**: Host permissions on matching tabs are enough to read `url` and `title` **(docs)**, so the broader `tabs` permission is not needed. The same host patterns let `scripting.executeScript` read page text for the snippet and let `fetch` reach the API without CORS. Browser-internal and extension pages never match `http(s)`, so they are invisible by construction (FR-013). `incognito: "not_allowed"` means the extension "cannot be enabled in incognito mode" **(docs)**. The docs do not say whether that also hides incognito tabs from the extension, so every code path additionally checks `tab.incognito` (defence in depth). The badge is the "minimal status indication" FR-016 allows; it needs no permission.
- **Alternatives considered**: `tabs` permission (grants more than needed); `<all_urls>` (also matches `file://` and others we do not want to read); `activeTab` (only fires on user gesture, useless for background ingestion); a `content_scripts` entry at `document_idle` (always-on script in every page; on-demand `executeScript` after the settle wait is lighter).

## 3. Service worker lifecycle and where state lives

- **Decision**: Register every listener synchronously at the top level of `background.ts`. Keep no durable state in memory. All durable state lives in `chrome.storage.local`. A 30-second periodic alarm (`sync`) is the heartbeat that drains the backlog and flushes overdue debounces. An in-process drain is also scheduled about 1 second after each enqueue or flush, so delivery does not wait for the heartbeat; the alarm is the fallback and the retry pickup.
- **Rationale**: The worker stops "after 30 seconds of inactivity" and "any global variables you set will be lost if the service worker shuts down" **(docs)**; a single event or API call may run up to 5 minutes and a `fetch()` response may take up to 30 seconds **(docs)**. Chrome limits alarms to "at most once every 30 seconds" **(docs)**, which matches the 30-second heartbeat.
- **Alternatives considered**: An offscreen document or a long-lived port to keep the worker alive (works, but adds a second execution context and fights the platform); relying on in-memory `setTimeout` alone (lost on termination, so it is only an optimisation on top of the persisted state); a full reconcile every time the worker wakes (not done: Chrome delivers every tab event to a woken worker, so nothing is missed, and a reconcile costs a storage read per tab on every wake).
- **As built**: the heartbeat tick and the reset at install and browser start live in `src/heartbeat.ts`, so they can be tested and `background.ts` stays wiring only.

## 4. Debounce ("settle") and the maximum-delay cap

- **Decision**: A tab's `updated` report goes out about **2 seconds** after its last change (spec, clarification Q5). To keep a continuously changing tab from never being reported, a tab that has been dirty for **30 seconds** is flushed anyway (maximum-delay cap). Opens, closes, and activations bypass the wait. Timers are in memory for speed; the pending set is persisted with a `lastChangeAt` and `firstDirtyAt` per tab, and the heartbeat alarm flushes anything overdue after a worker restart.
- **Rationale**: Resolves the gap left open by clarification ("a title that keeps updating would never be reported"). 30 seconds matches the heartbeat granularity, and SC-001's 5 seconds applies to normal changes, not to a tab that never settles.
- **Alternatives considered**: A cap of 10 seconds (more traffic for chatty pages such as a mail tab with an unread counter); no cap (leaves the gap).

## 5. Mapping Chrome tab events to spec events

- **Decision**: A tab becomes **tracked** the first time it is observed with an eligible URL (`http:` or `https:`, non-incognito). Then:
  - `tabs.onCreated` with an eligible URL, or the first eligible URL seen later → `opened`. The later case is emitted at the settle flush, because a new tab usually starts on an internal page and navigates.
  - `tabs.onUpdated` (`url`, `title`, `status: "complete"`) on a tracked tab → coalesced `updated`, emitted only when the URL or title differs from the last reported state.
  - `tabs.onActivated` and `windows.onFocusChanged` (to a real window) → `activated` for the newly active tab if it is tracked.
  - `tabs.onRemoved` → `closed` for a tracked tab, using the last known URL and title.
  - A tracked tab that navigates to an ineligible URL ends tracking and emits `closed` without reporting the excluded URL. A later return to an eligible URL emits `opened` again.
  - `tabs.onAttached` / `onDetached` (move between windows): no event; the tab is the same tab, and its new window id is refreshed on the next snapshot.
  - `tabs.onReplaced` (a tab swapped out by prerendering): `closed` for the old id and, once it settles, `opened` for the new id. The new id is one the backend has never seen, and deciding that it is "the same tab" would be the extension deciding identity, which FR-017 forbids.
  - `reassigned` is never emitted here; it belongs to workspace features.
- **Rationale**: These are the events the tabs API exposes: `onCreated`, `onUpdated` (with `changeInfo` `status`/`url`/`title`), `onActivated`, `onRemoved`, `onAttached`, `onDetached`, `onReplaced`, `onMoved` **(docs)**. Ending tracking on navigation to an internal page satisfies FR-013 without ever sending the internal URL, and the spec edge case "moved to another window is not a close plus an open" is met by ignoring attach and detach.
- **Alternatives considered**: Emitting `opened` at creation regardless of URL (would leak or send empty internal-page records); polling `tabs.query` on a timer (loses precise event times).

## 6. Active-tab signal

- **Decision**: Two signals. (a) `activated` events for tracked tabs. (b) Every request carries `active: { windowId, chromeTabId }`, sampled when the batch is built: the focused window and its active tab if that tab is tracked, otherwise `chromeTabId: null`. Snapshot items also carry `active` and `windowId`.
- **Rationale**: Activation events alone cannot say "the previous tab is no longer active" when the user moves to an untracked tab (an internal page). A state sample on every batch fixes that without extra event types. The 001 model has no `active` field, so this stays in the ingest contract as transient data; feature 003 decides how to store or derive it.
- **Alternatives considered**: A new event type for deactivation (needs a change to the shared `TabEventType`); sending nothing for untracked activations (leaves the backend wrong).

## 7. Snippet capture

- **Decision**: After a tab settles and its status is `complete`, run `chrome.scripting.executeScript` once with a small function that returns `document.body.innerText` with whitespace collapsed, truncated to **2000 characters** (`SNIPPET_MAX_LENGTH`, from the 001 data model). Read the page when the address changed, nothing is cached, or the last read found no text (a page that had not rendered yet); otherwise reuse the cached snippet. A snippet is only reused for the address it was read from. Never read a page that is still loading or a discarded tab. The last snippet is cached per tab (`snip:<chromeTabId>`), and a full snapshot reads at most 5 pages at once. Any error (restricted page, PDF viewer, Web Store, script blocked) yields an empty snippet and never blocks the tab or its events (FR-005).
- **Rationale**: Plain text only, never markup (FR-004). One capture per settled navigation keeps CPU and traffic low. It does not chase later in-page content changes; the spec does not ask for that.
- **Alternatives considered**: A persistent content script pushing text on every DOM mutation (heavy, privacy-noisy); `og:description`/meta only (often empty, weak for clustering).

## 8. Durable backlog

- **Decision**: `chrome.storage.local` with sequence-numbered keys.
  - `ev:<seq>` holds one queued event; `meta` holds `{ head, tail }`.
  - `dirty:<chromeTabId>` holds the latest snapshot per tab, with a `ready` flag (false while the tab settles); `dirty:ids` is the index.
  - `mirror` holds the last reported `{url, title, windowId, lastSeenAt}` per tracked tab.
  - `snip:<chromeTabId>` holds the last snippet read for a tab and its address.
  - `state` holds the sync state.
  - Batches read a `head..head+N` range and delete it on acknowledgement.
  - Pruning is by age: while the head event is older than 24 hours, drop it, count it, and set `needsFullSnapshot`. A count ceiling (20,000) is a safety valve using the same path.
- **Rationale**: Per-key access is O(batch), not O(backlog), and one `storage.local.set` with several keys is a single call, which keeps event and dirty updates together. `storage.local` is 10 MB and persists across browser restarts **(docs)**. At about 300 bytes per event, 24 hours of a few thousand events is roughly 1–2 MB, and snapshots are bounded by open-tab count times about 2.5 KB. Snippets only ever live in `dirty` and the per-tab `snip:` cache, never in `ev`, so the backlog cannot grow with page text.
- **Alternatives considered**: IndexedDB (real ordered store and transactions, but more boilerplate and an extra test dependency for a queue this small; revisit if quota pressure shows up); one big array under one key (rewrites the whole backlog on every event); `storage.session` (not chosen for durability, and the docs summary I got was unclear about worker termination).

## 9. Delivery, retry, and identity

- **Decision**: One request format (`contracts/ingest-api.md`): `POST {API_BASE_URL}/api/ingest/tabs` with `Authorization: Bearer <device token>`, carrying up to 100 events, all pending snapshots, a `fullSnapshot` flag, the active-tab sample, and a `batchId`. Single sender at a time. Handling:
  - 200 → acknowledge: delete the sent event range, and each snapshot only if it did not change while the request was in flight.
  - Network error, timeout, 408, 429, 5xx, and any status not listed here (a 404 from a wrong address, for example) → keep everything, back off exponentially from 2 s to 5 min with up to 20% jitter, and let `Retry-After` override the delay. Nothing is sent until the retry time. Retries are picked up by the drain scheduler or the 30-second heartbeat, so recovery after an outage takes as long as the delay in force when the backend returns: after a long outage that is the 5-minute cap. Reloading the extension or restarting the browser clears the wait.
  - 401 or 403 → set `auth_failed`, request a fresh snapshot for later, stop sending, keep everything, show the badge (FR-011). Sending stays stopped until a reload or browser start resets the status, which is also how a rebuild with fixed credentials recovers.
  - 413, 400, or 422 → split the events in half and send the halves separately until one event is left. A lone event that is still rejected is quarantined (removed and counted), so one bad event never blocks the queue. If the events are accepted and the snapshots are what the server rejects, the snapshots are quarantined too (all of them together; the next change or full snapshot resends them).
  - Events get a `crypto.randomUUID()` id when captured, so a retried delivery is recognised (FR-008). The backend counts an id once.
  - A full snapshot is requested on install or reload, on browser start, after any dropped events, and after `auth_failed`. The sender takes it itself, right before building the request, and the request lists every open tab, including ones still settling, because omitting a tab would tell the server it closed. The request flag is cleared when the server acknowledges it, or rejects it as invalid, so a permanently rejected snapshot cannot loop.
- **Rationale**: Directly implements FR-006 to FR-011. The backend owns tab identity (clarification Q2), so the extension sends address, title, and the current browser tab id, and never invents its own tab identifier.
- **Alternatives considered**: WebSocket (keeps the worker alive but the server does not exist yet, so it is speculative); sending one request per event (chatty, harder to keep in order).

## 10. Configuration and secrets

- **Decision**: Build-time env in `apps/extension/.env` (`VITE_API_BASE_URL`, `VITE_DEVICE_TOKEN`), read in `vite.config.ts` and inlined into the bundle. A committed `apps/extension/.env.example` documents them with blank values; the root `.gitignore` gets `!apps/*/.env.example` because it currently ignores `apps/*/.env*`. If either value is missing, the extension stays idle, shows the badge, and logs once.
- **Rationale**: Clarification Q4 (build time, no settings screen). The token is embedded in the built bundle, so `dist/` must never be committed or shared (`dist/` is already ignored) and builds with a real token are for development only until feature 003's pairing.
- **Alternatives considered**: Extra slots in the root `.env.example` (one file, but it is currently deleted in the working tree and is not extension-specific); a settings page (rejected in Q4).

## 11. Shared types

- **Decision**: Add `packages/shared/src/ingest.ts` exporting request and response types **derived from** the canonical ones with `Pick`/`Omit`, plus `SNIPPET_MAX_LENGTH`. Re-export from `index.ts`.
- **Rationale**: `TabRef` and `TabEvent` carry fields the extension cannot know (`userId`, `tabRefId`, `workspaceId`, server-assigned `id`). Deriving the input types keeps a single source of truth (FR-015, constitution Principle V) instead of a second, parallel definition.
- **Alternatives considered**: Sending full `TabRef`/`TabEvent` objects with placeholder ids (lies about the data); defining the types inside `apps/extension` (forks the model).

## 12. Testing and the stand-in receiver

- **Decision**: Vitest ^5 (peer range covers Vite 7) for pure logic: eligibility filter, snippet trimming, debounce and max-delay coalescer, store and prune, batch builder, retry and backoff, response handling. A hand-rolled in-memory `chrome.storage.local` mock is enough. A dependency-free `apps/extension/scripts/stub-receiver.mjs` (Node `http`) stands in for the backend. It logs each batch, checks the bearer token, dedupes events by id, and has switches to fail with 500, 401, or slow responses. The real sender is also tested over real HTTP against the real stub process (`tests/stub-integration.test.ts`), and static guards check the manifest, the absence of tab-mutating calls, and that nothing from incognito or internal pages is stored or sent. Checks that need a real Chrome are manual in `quickstart.md`.
- **Rationale**: Reliability is this feature's stated focus, so the queue and retry logic earn real tests; the constitution prefers integration checks over test theatre, so nothing beyond that is added. The stub is also what makes "done" verifiable before feature 003 exists.
- **Alternatives considered**: Playwright driving Chromium with the extension loaded (real end-to-end, but heavy for this stage; can be added later); no unit tests (leaves the ordering, duplicate, and prune rules unchecked).

## Verify empirically (turned into quickstart checks)

1. **Alarm wakes a terminated worker.** The alarms page says an alarm "will not wake up a device"; the tool that summarised it also read that as "won't wake a terminated worker", which contradicts common MV3 practice. The design relies on the alarm restarting the worker, so this is checked by stopping the worker and watching the heartbeat resume.
2. **`http://*/*` covers `http://localhost:<port>`.** Believed to (match patterns ignore ports) but not confirmed from the docs; checked by sending to the local stub.
3. **`incognito: "not_allowed"` behaviour.** The docs do not say whether incognito tabs are then invisible; the code checks `tab.incognito` anyway and the quickstart tests an incognito window with the toggle both ways.
4. **Browser tab ids across restart.** The docs do not address it. The design does not depend on either answer, because the post-start full snapshot rebinds ids either way.

## Clarifications

No remaining NEEDS CLARIFICATION items in the Technical Context. The plan-level questions left over from the spec (maximum-delay cap, request format, settings surface) are decided above.
