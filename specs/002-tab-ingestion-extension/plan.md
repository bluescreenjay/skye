# Implementation Plan: Tab Ingestion Extension

**Branch**: `002-tab-ingestion-extension` | **Date**: 2026-09-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-tab-ingestion-extension/spec.md`

## Summary

Turn the empty extension shell from feature 001 into a background-only ingestion worker. It observes normal Chrome windows only, tracks every eligible tab (`http(s)`, non-incognito), and pushes tab snapshots and timestamped events to a configurable backend. It keeps a durable, ordered, 24-hour backlog so an outage or browser restart loses nothing, and it de-duplicates by stable event ids. The backend owns tab identity, so the extension never invents a tab identifier; it reports address, title, and the current browser tab id, and sends a fresh full snapshot after every start. There is no UI beyond a status badge.

Approach: an MV3 service worker registering listeners at the top level and keeping all state in `chrome.storage.local`; a 2-second settle with a 30-second cap; snippets via on-demand `scripting.executeScript`; one batched `POST` per cycle (scheduled about 1 s after each queued change, with the 30 s heartbeat as the fallback) with bearer-token auth and exponential backoff; build-time configuration; a dependency-free stub receiver for verification until feature 003 provides the real API. Wire types are derived from the 001 types and added to `packages/shared`.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), as in feature 001; Node 22+ for tooling; Chrome MV3 service worker runtime (recent desktop Chrome)

**Primary Dependencies**: `vite` ^7 and `@crxjs/vite-plugin` ^2 (installed in 001); `@types/chrome`; `vitest` ^5 (new, dev only); `@ai-browser/shared` (workspace). No runtime dependencies.

**Storage**: `chrome.storage.local` (10 MB quota, persists across browser restarts): sequence-keyed event backlog, per-tab snapshots (pending or ready), a tracked-tab mirror, a per-tab snippet cache, and sync state. No database in this feature.

**Testing**: Vitest for pure logic (eligibility, snippet trimming, coalescer, store and prune, batching, retry and backoff, response handling) with an in-memory `chrome.storage` mock; `tsc --noEmit` across workspaces; a stand-in receiver script that the real sender is also tested against over real HTTP; static guards for the manifest, tab-mutating calls, and privacy; and the manual scenarios in `quickstart.md` for what needs a real Chrome.

**Target Platform**: Chrome desktop, loaded unpacked from `apps/extension/dist`. Later a Node-hosted Next.js API (feature 003) is the receiving end.

**Project Type**: pnpm monorepo; this feature is a background-only MV3 extension plus a small shared-types addition.

**Performance Goals**: 95% of tab changes visible at the backend within 5 s (SC-001); 100-tab initial snapshot within 15 s (SC-002); no perceptible browsing slowdown at 100 tabs (SC-006).

**Constraints**: Service worker stops after 30 s idle and loses memory, so state is persisted and a 30 s heartbeat alarm drains and flushes; alarms are limited to once per 30 s; no incognito or non-`http(s)` data; no UI beyond a badge; snippet ≤ 2000 plain-text characters; backlog ≥ 24 h, ceiling 20,000 events; secrets never committed and the token only in a gitignored build env.

**Scale/Scope**: About 100 open tabs; a few thousand events per day; one device per user; one source of truth for types (`@ai-browser/shared`).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How this plan complies |
| --- | --- | --- |
| I. Workspace-First | PASS | The extension carries no workspace concept. It supplies tab state and events that workspaces are built from, and leaves membership empty (Other). |
| II. Extension observes and presents; server decides | PASS | Observes only. Never moves, groups, or names tabs, never runs AI or clustering, and never decides tab identity; the backend matches tabs and de-duplicates. |
| III. User corrections win | PASS (n/a) | No organisation is performed, so nothing can override a user correction. |
| IV. Least-power actions | PASS | Plain browser event listeners, `fetch`, and a small scripted text read. No agents, no MCP, no computer use. |
| V. One TypeScript surface | PASS | TypeScript throughout. Ingest types are `Pick`-derived from `TabRef` and `TabEvent` in `@ai-browser/shared`; nothing is redeclared in the extension. |
| VI. Demo-hard, architecture-soft | PASS | Delivers step one of the core loop (ingest). Reliability logic gets tests because it is the feature's stated focus; no extra platform layers. |
| VII. Two surfaces | PASS | No Home (`chrome_url_overrides`), no Side Panel, no settings page. The manifest contract lists them as forbidden. |
| Stack and pivots | PASS | Chrome MV3 + Vite + CRXJS per the constitution. No vendor is involved yet; the receiving API is feature 003 (Tiger or Supabase pivot is the server's concern). |
| Secrets | PASS | `apps/extension/.env` is gitignored; only a blank `.env.example` is committed; `dist/` (which embeds the token) is gitignored. |

**Gate result (pre-research): PASS.** No complexity-tracking violations.

## Project Structure

### Documentation (this feature)

```text
specs/002-tab-ingestion-extension/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── checklists/
│   └── requirements.md
├── contracts/
│   ├── ingest-api.md
│   ├── shared-ingest-types.md
│   └── extension-config.md
└── tasks.md             # Phase 2, created by /speckit-tasks, not this command
```

### Source Code (repository root)

```text
apps/extension/
├── vite.config.ts            # NEW: crx() plugin, reads VITE_* from .env
├── manifest.config.ts        # CHANGED: permissions, host_permissions, incognito, action
├── package.json              # CHANGED: build, test, stub scripts; vitest dev dependency
├── .env.example              # NEW: VITE_API_BASE_URL, VITE_DEVICE_TOKEN (blank)
├── tsconfig.json             # CHANGED: include tests and config files; types chrome + node
├── vitest.config.ts          # NEW: unit test config
├── scripts/
│   └── stub-receiver.mjs     # NEW: dependency-free stand-in for the backend
├── src/
│   ├── background.ts         # CHANGED: top-level listener registration and wiring only
│   ├── config.ts             # NEW: build-time env, validation
│   ├── filters.ts            # NEW: eligibility (http(s), not incognito)
│   ├── store.ts              # NEW: storage.local backlog, dirty map, mirror, state; 24 h prune
│   ├── collector.ts          # NEW: Chrome events to backlog/dirty; settle and max-delay
│   ├── snapshot.ts           # NEW: full snapshot via tabs.query; active-tab sample
│   ├── snippet.ts            # NEW: scripting.executeScript text capture and trim
│   ├── sender.ts             # NEW: batching, fetch, backoff, response handling
│   ├── status.ts             # NEW: badge text
│   ├── heartbeat.ts          # NEW: the 30 s tick, and the reset at install and browser start
│   └── domain-check.ts       # existing (001)
└── tests/                    # NEW: Vitest suites for the pure modules
    └── helpers/chrome-mock.ts  # NEW: in-memory chrome.* stubs for the tests

packages/shared/
├── src/ingest.ts             # NEW: derived ingest types and SNIPPET_MAX_LENGTH
├── src/index.ts              # CHANGED: re-export ingest
└── README.md                 # CHANGED: list the ingest types

.gitignore                    # CHANGED: add !apps/*/.env.example
```

**Structure Decision**: Keep everything inside the existing `apps/extension` shell from 001, with one small module per responsibility so the reliability logic (store, collector, sender) is testable without Chrome. The only cross-package change is one new file in `packages/shared`, which keeps types single-sourced. The web app is untouched.

## Complexity Tracking

> No constitution violations. Table left empty.

Notes on scope, not violations:
- `packages/shared` gains one file. Research 001 §2 allows "types and small consts"; `SNIPPET_MAX_LENGTH` is the only constant.
- One new dev dependency (`vitest`) and no runtime dependencies.

## Deviations from the original design

Found while implementing. The design documents above have been updated to match; this is the list of what changed and why.

- **A replaced tab is `closed` plus `opened`, not `closed` plus `updated`.** The new tab id is one the backend has never seen; calling it "the same tab" would be the extension deciding identity, which FR-017 forbids.
- **A full snapshot lists every open tab, including ones still settling, and the sender takes it itself** just before building the request. Otherwise a tab that changed a moment ago would be omitted and the server would conclude it had closed.
- **Snapshots carry a `ready` flag.** The design had one "pending" notion doing two jobs (still settling, and waiting to be sent). A normal request sends only ready snapshots; a full snapshot sends all.
- **Snippets have their own per-tab cache (`snip:<tabId>`).** Reusing a snippet for an unchanged address needs somewhere to remember it, and the mirror was the wrong place (100 tabs of text rewritten on every change). It also retries a page whose last read was empty, never reads a loading or discarded tab, and reads at most 5 pages at once during a full snapshot.
- **The heartbeat lives in `src/heartbeat.ts`, and there is no reconcile on every worker wake.** The first keeps `background.ts` wiring only and makes the tick testable. The second was in the task list but costs a storage read per tab on every wake, and Chrome already delivers every tab event to a woken worker.
- **Recovery after an outage is not "about 30 seconds".** It is however long the retry delay in force is, up to the 5-minute cap; a reload clears it. The earlier claim ignored that backoff keeps growing.
- **Rejected credentials stay stopped until a reload or browser start**, rather than "until the next successful send", which could never happen while sending was stopped.
- **Any unlisted status (a 404 from a wrong address, for example) is treated as transient**, so it can never cost data.
- **Snapshots the server rejects on their own are quarantined together**, not bisected one by one. The next change or full snapshot resends them, so nothing durable is lost.
- **A snapshot's `active` flag is a point-in-time hint.** Activation events and the request-level `active` sample are authoritative; activating a tab does not queue a new snapshot.

## Phase 0 / Phase 1

Research, data model, contracts, and quickstart are in this directory. Post-design constitution check: still **PASS**. Design adds one derived-types file, extension modules, and a stub script; it adds no UI, no second definition of the domain types, no client-side identity or organisation logic, and no committed secrets.

## Risks carried forward

- **Alarm wakes a stopped worker**, `http://*/*` **covering localhost ports**, and **`incognito: "not_allowed"` visibility** could not be confirmed from the docs and are checked in `quickstart.md`.
- **Full "done" is deferred.** Server-visible records need feature 003; this feature is done when correct records reach the configurable endpoint (spec Assumptions).
- **Matching by address** is imperfect and is recorded as a hand-off in `contracts/ingest-api.md`. 003's specify prompt should include it.

## Next

`/speckit-tasks` to break this plan into implementation tasks.
