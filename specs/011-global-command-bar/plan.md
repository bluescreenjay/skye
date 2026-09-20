# Implementation Plan: Global Command Bar

**Branch**: `011-global-command-bar` | **Date**: 2026-09-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/011-global-command-bar/spec.md`

## Summary

One shared command bar (⌘K), mounted on Home as its URL bar (answers drop down under it) and in the Side Panel while a page is open, that turns one typed sentence into **one fixed intent** and does that one thing. Submitting makes **one** AI request that returns a structured intent (a closed list of 13 intents plus three non-actions); every sentence the person reads is a fixed template filled with values the server checked, never model prose. What the intent then does reuses what exists: organize is `runClustering` (Home's own code), agents are the 010 press route and client, moves record the person's own placement like a drag. Anything that moves tabs the person placed, renames or merges a workspace, or closes a tab shows exactly what it will change and waits for a separate confirmation, and the **server** decides that on the current state.

Server (`apps/web`): a `src/command/` module and three routes: `POST /api/command` (interpret; changes nothing), `POST /api/command/apply` (do it, or answer `needs_confirmation`), `GET /api/command/undo`. One new table with **one row per person** holds the single most recent change for Undo, for 10 minutes. Client (`apps/extension`): one shared `CommandBar` component, a small host bridge, a manifest `commands` entry for the shortcut, and a `chrome.storage.session` signal so Home and the sidebar refresh without a reload. Duplicate tabs are found and closed in the extension, because the server cannot see them. Design detail: [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), validation: [quickstart.md](./quickstart.md).

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node 22, Next.js 16 App Router (`apps/web`); React 19 and Chrome Manifest V3 (`apps/extension`). `apps/web/AGENTS.md` warns Next 16 differs from older versions; the route-handler guide (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`) is read before the routes are written. This feature adds only ordinary JSON handlers (`POST`, `GET`), the same shape as the 004 and 010 routes.

**Primary Dependencies**: `@ai-browser/shared`, `pg`, the shared AI layer (`src/llm/`, purpose `command` already exists), the existing `src/cluster/` (`runClustering`, `undoRun`, `findExistingWorkspace`, `recordReassignments`) and `src/agents/` modules, and in the extension `ui/agents.ts` (`pressAgent`, `readAgents`, `resultText`). **No new runtime dependency.**

**Storage**: Existing Postgres (Tiger). One new idempotent migration, `packages/shared/sql/011_command.sql`: the table `command_undo` (primary key `user_id`, so one row per person). No new column on an existing table, no new index (recall uses `tab_events_user_time_idx`).

**Testing**: `tsc --noEmit`; Vitest on PGlite with an injected fake interpreter (`CommandModel`), 004's fake cluster model, and 010's fake agent model (no network, no key; nothing touches Tiger). A fixture of 45 phrasings covers every intent. Extension unit tests for the pure client, reducer, signal, duplicate, and shortcut-handler modules on the existing chrome mock. One opt-in live check (`COMMAND_LIVE=1`) against the active provider (SC-002, SC-003, SC-009, SC-014); one manual pass on a real Chrome for the shortcut and the panel.

**Target Platform**: A local Next.js server that can reach the AI provider (the VT VPN for the default provider); the Chrome extension (Chrome 116+ for the Side Panel API, as 006).

**Project Type**: Web API in `apps/web`, a UI component and browser glue in `apps/extension`, a types file in `packages/shared`.

**Performance Goals**: The bar opens within 1 s (SC-001). A command is understood and started within 5 s in 9 of 10 runs (SC-003): one request over at most about 12,000 tokens at low reasoning effort, 20 s deadline as a backstop. Home and the sidebar show a change within 5 s (SC-004).

**Constraints**: Every query filters by `user_id`. Exactly one AI request per submitted command and none for opening, typing, empty input, `apply`, or the undo read. Nothing changes without a submit; nothing that moves a person-placed tab, renames, merges, or closes a tab happens without a separate confirmation. Nothing is retried by the bar. No page is fetched (find is over saved titles, addresses, and excerpts). Command text, tab titles, addresses, and results are never logged (class names only). No 010b tool, no computer use, no multi-step planning. No new permission.

**Scale/Scope**: At most 150 tabs and 40 workspaces in the model material; at most 200 tabs per change; at most 20 preview lines; 8 found tabs; one undo row per person. Three routes, one migration, one shared types file, one shared component, one shortcut handler.

## Constitution Check

*GATE: Must pass before Phase 0. Re-check after Phase 1.*

| Principle | Status | How this plan complies |
| --- | --- | --- |
| I. Workspace-First | PASS | Merge moves tabs only; the emptied workspace keeps its chat, plan items, and saved results. Closing tabs never destroys a workspace (records persist). Nothing here deletes a workspace. |
| II. Extension observes and presents; server decides | PASS | Interpretation, name resolution, confirmation rules, moves, renames, merges, recall, find, and undo are all server-side. The extension hosts the UI, reads which tabs are open, and closes the confirmed duplicate copies (the one thing only the browser can do; the server cannot see a second tab of the same page, `src/ingest.ts`). |
| III. User corrections win | PASS | Moves are recorded as the person's own placement, write `corrections` rows for AI-placed tabs, and are always confirmed. A general organize never moves a hand-placed tab. Undo never touches a tab the person has since moved or a name they have since changed. |
| IV. Least-power actions | PASS | An intent router over a closed list, one request, no tools, no loop, no plan. `unsupported` is the answer to anything else. No MCP or 010b tool, no computer use (FR-022). Agents are the fixed catalog, pressed through their own route. |
| V. One TypeScript surface | PASS | Types live in `@ai-browser/shared` (`command.ts`). One `CommandBar` component is mounted by Home and the sidebar; neither forks it. Agent press and result rendering are the existing shared functions. |
| VI. Demo-hard, architecture-soft | PASS | This is the last step of the MVP loop (v1.4.0). It uses the provider-neutral AI layer; a failed or unconfigured AI service gives a plain message and never blocks the rest of the product (FR-024, SC-013). |
| VII. Two surfaces | PASS | The bar is available on Home (the URL bar) and while a page is open (Side Panel). Home is not the only place, and the sidebar does not replace the directory. |
| Stack / secrets | PASS | No new vendor, dependency, or secret. No new extension permission; one manifest `commands` key. |
| Persistence: user-scoped rows | PASS | `command_undo` is keyed by `user_id` with a foreign key to `users`; every read and write filters on it. |

**Gate result: PASS** (before Phase 0).

**Post-design re-check: PASS.** Phase 1 added one small table (justified in [research.md §6](./research.md#6-undo-one-row-per-person-guarded-expiring)) and one manifest key; neither conflicts with a principle. Two places where the spec's own words disagree with each other, and one where its reading is interpreted, are recorded under "Spec points to flag" below; none needs a constitution change.

## Project Structure

### Documentation (this feature)

```text
specs/011-global-command-bar/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── http.md                    # the three routes
│   ├── model.md                   # the interpreter call: seam, prompt data, rules, schema, validation
│   ├── shared-command-types.md    # packages/shared/src/command.ts
│   └── extension.md               # manifest, modules, host bridge, shortcut handler, signals, bar behaviors
├── checklists/requirements.md
└── tasks.md                       # /speckit-tasks, not created here
```

### Source Code (repository root)

```text
packages/shared/
├── sql/011_command.sql                 # NEW: command_undo (idempotent)
└── src/
    ├── command.ts                      # NEW: CommandContext/Request/Action/Reply/ApplyResult, UndoState, ... (types + COMMAND_INTENTS)
    └── index.ts                        # + export * from "./command"; header comment lists 011_command.sql

apps/web/
├── app/api/command/
│   ├── route.ts                        # NEW: POST interpret
│   ├── apply/route.ts                  # NEW: POST apply
│   └── undo/route.ts                   # NEW: GET undo state
├── src/command/                        # NEW module
│   ├── limits.ts        # every fixed number (data-model.md "Limits")
│   ├── messages.ts      # EVERY sentence the person can see; the model never supplies one
│   ├── model.ts         # CommandModel seam; getCommandModel(); setCommandModelForTests()
│   ├── prompt.ts        # fixed rules + the one JSON data block; short-id maps
│   ├── schema.ts        # the strict answer schema; the intent list
│   ├── validate.ts      # pure answer checks (contracts/model.md "Validation")
│   ├── context.ts       # current workspace / "these tabs" resolution; material queries
│   ├── interpret.ts     # gather -> ask once -> validate -> resolve -> reply
│   ├── resolve.ts       # interpretation -> CommandReply (workspace matching rules, asks, says)
│   ├── apply.ts         # dispatcher: confirmation table, per-action execution, outcome
│   ├── changes.ts       # group / move / merge / create / rename in one transaction each
│   ├── organize.ts      # runClustering wrapper, error mapping, undo-row registration
│   ├── undo.ts          # command_undo read/write/expire; the undo rules
│   ├── recall.ts        # tab_events aggregation for a period
│   ├── period.ts        # vocabulary -> [start, end) in an IANA time zone (DST-safe)
│   ├── find.ts          # ranked ids -> FoundTab / FoundWorkspace
│   ├── errors.ts        # CommandRequestError; typed AI errors -> fixed sentences (uses llm/situation)
│   └── guard.ts         # route guard: token + body parsing shared by the routes
├── src/llm/budget.ts                   # CHANGED: command share 20 -> 60; chat 170 -> 150; actions 120 -> 100
└── tests/
    ├── command.test.ts                 # routes and lifecycle (fake interpreter)
    ├── command-validate.test.ts        # answer validation, closed enum, short ids, parts, names
    ├── command-changes.test.ts         # confirmation table, moves, rename, merge, create, name rules
    ├── command-undo.test.ts            # every guard, the 10-minute window, replace-on-next-change
    ├── command-recall.test.ts          # periods (incl. DST), ordering, empty day, no events counted for reassigned
    ├── command-find.test.ts            # ranking, archived excluded, no fetch, "more" note
    ├── command-safety.test.ts          # 5 hostile-text styles, log scan, counters (0 for empty, 1 per submit)
    ├── command-helpers.ts              # fake interpreter, seeding, ctx builders, apply/say wrappers
    ├── command-live.test.ts            # opt-in COMMAND_LIVE=1: the 45 phrasings, finds, timing, hostile styles
    ├── fixtures/command-phrasings.json # 45 phrasings: text, expected intent, ambiguous/unsupported flags
    └── global-setup.ts                 # CHANGED: also apply 011_command.sql

apps/extension/
├── manifest.config.ts                  # CHANGED: + commands["open-command-bar"]
├── src/
│   ├── background.ts                   # CHANGED: installCommandShortcut({ openHome }) (wiring only)
│   ├── command-shortcut.ts             # NEW: the onCommand handler (sidePanel.open before any await)
│   ├── ui/                             # the folder Home and the sidebar already share
│   │   ├── command.ts                  # NEW: client + pure helpers + reducer + EXAMPLES + clipCommand
│   │   ├── command-signal.ts           # NEW: command.signal in storage.session
│   │   ├── CommandBar.tsx              # NEW: the shared component (imports nothing Home- or sidebar-specific)
│   │   └── command.css                 # NEW
│   ├── home/
│   │   ├── command-host.ts             # NEW: the CommandHost bridge (chrome.tabs / windows live here)
│   │   ├── close-duplicates.ts         # NEW: findDuplicateTabs, closeDuplicateTabs
│   │   ├── navigation.ts               # CHANGED: + showHome(target)
│   │   ├── Home.tsx                    # CHANGED: mount the bar in an error boundary; ⌘K button; signals
│   │   └── home.css                    # CHANGED: the ⌘K button
│   └── sidebar/
│       ├── Sidebar.tsx                 # CHANGED: mount the bar; ⌘K button; signals
│       └── sidebar.css                 # CHANGED: the ⌘K button
└── tests/
    ├── command-client.test.ts          # clipCommand, reducer, request mapping, agent wait (fake fetch)
    ├── command-signal.test.ts          # signals, freshness, toggle
    ├── command-shortcut.test.ts        # handler order and branches; open is called before any await
    ├── close-duplicates.test.ts        # which copy stays, pinned never closed, changed tab skipped
    ├── manifest.test.ts                # CHANGED: `commands` no longer forbidden; asserts the exact entry
    ├── observe-only.test.ts            # CHANGED: chrome.sidePanel also allowed in command-shortcut.ts
    └── helpers/chrome-mock.ts          # CHANGED: + storage.session (get/set/onChanged), commands.onCommand

.env.example                            # + COMMAND notes (LLM_MODEL_COMMAND already listed); no new variable required
apps/web/README.md                      # + "Command bar (feature 011)" section and routes
```

**Structure Decision**: The existing monorepo. Server code goes in a new `src/command/` beside `src/chat/`, `src/cluster/`, and `src/agents/`; routes under a new `/api/command` tree. The shared component goes in `apps/extension/src/ui/` (the folder both surfaces already share), and everything that changes tabs goes in `src/home/`, the pattern `closeHomeTab` already uses and the only place `observe-only.test.ts` permits `chrome.tabs.remove`. The bar never touches 004's, 007's, or 010's code paths except by calling them.

## Changes outside this feature's own files (flag when doing them)

| Change | Why | Where |
| --- | --- | --- |
| `commands` key added to the manifest; the test that forbids it is changed to assert the one entry | The shortcut is a manifest `commands` entry (no new permission) | `manifest.config.ts`, `tests/manifest.test.ts` (the 006 and 002 contracts mention the "deliberately absent" list; note it there) |
| `chrome.sidePanel` also allowed in `command-shortcut.ts` | The shortcut handler must call `sidePanel.open` in the same turn as the shortcut | `tests/observe-only.test.ts` (one filename added to the existing exemption) |
| `storage.session` and `commands.onCommand` added to the chrome mock | The signals and the handler are tested | `tests/helpers/chrome-mock.ts` |
| `command` daily share 20 to 60; chat 170 to 150; actions 120 to 100 | One request per command; 20 a day is too small for real use and for the live check. The shares still total 400 and, with the 50 spill-over, the 450 cap | `src/llm/budget.ts`, `tests/llm.test.ts` (asserts the numbers), `.env.example` comment |
| `011_command.sql` added to the test database setup | The new table | `apps/web/tests/global-setup.ts`, `packages/shared/src/index.ts` header |
| `usableName` exported (one word added) | The command validator applies the clustering name rule instead of copying it | `apps/web/src/cluster/prompt.ts` (existing 004 tests cover it) |
| `showHome(target)` added to Home's navigation helpers | One place that focuses or opens Home and sends the `navigate` signal | `apps/extension/src/home/navigation.ts` |
| Home and the sidebar mount the bar and listen for signals | The two surfaces | `Home.tsx`, `Sidebar.tsx`, their CSS |
| `FEATURES.md` has an uncommitted one-character edit ("004 005" missing a comma in the 011 "Depends on" line) | Not from this plan; noticed while reading | Left as is, for the person to keep or revert |

## Spec points to flag (not edited here; CLAUDE.md: flag, do not change)

1. **FR-020 versus User Story 2 scenario 5.** FR-020 says the bar must not archive a workspace; the story says Undo of a create "removes the workspace". Plan: Undo reverses the bar's own create by archiving it only if it is still empty and untouched (feature 004's rule, nothing deleted). Suggested spec fix: FR-020 gets "except undoing a workspace the same command created".
2. **Key Entities says "adds no new kind of saved record"**, while FR-030 and the Assumptions permit "what Undo needs for the most recent change". Plan: one table, one row per person, 10-minute life ([research §6](./research.md#6-undo-one-row-per-person-guarded-expiring)). Suggested spec fix: name that carve-out in Key Entities.
3. **Edge case "some tabs closed between the preview and the confirm: only the tabs still there move".** Tab records outlive their open tabs (constitution I), so the plan moves every tab whose record still exists and is not already in place, and reports the rest ([research §8](./research.md#8-restructuring-changes-one-transaction-each-same-rules-as-by-hand)). A stricter reading (skip closed tabs) would be a small change in `changes.ts`.
4. **"Where the bar lives while a page is open" was left to planning.** Decided: the Side Panel (research §5), with an automatic fallback to Home if Chrome will not open the panel from the shortcut.

## Risks and how the plan handles them

- **A hostile tab title steering the model to a wrong intent.** The design does not rely on the model being immune: a closed intent list, id validation, fixed sentences, confirmation for every restructure (showing exactly what changes), undo for organize, and read-only find, recall, and show mean a wrong pick can only be one of: an organize (undoable), an agent press (changes no tab), a read, or a preview that waits for a click. Five injection styles are in the live check (SC-009).
- **The shortcut might not reach the panel.** Chrome accepts a `commands` shortcut as the user gesture for `sidePanel.open`, but only when called before any `await`; the handler is written and tested for that order, falls back to opening Home, and the ⌘K button always works. A manual check on a real Chrome is a step in the quickstart.
- **Model quality on find and group with 150 tabs.** Titles and excerpts are short; the model is asked for a ranked list, not an answer; SC-014 is measured live. If it misses, the levers are `LLM_MODEL_COMMAND` and the tab cap.
- **Latency (SC-003).** One request of about 12,000 tokens at low effort. The live check records the timing of 10 runs; the levers are the same as above.
- **Undo cannot tell a move from a move-and-back** (research §6). The same limit as 004's undo; recorded.
- **Duplicates depend on Chrome's live tab list.** Detection and closing are re-checked tab by tab at confirm time; a changed or pinned tab is skipped. Closing is not undoable and the confirm list says so.
- **One server process.** The advisory lock and the single-row undo table are database-level, so several processes agree; organize's own single-run guard (004) still applies. Recorded, as in 008 and 010.
- **Budget interaction.** Commands share the 450/day cap with chat, clustering, and agents; a busy day can leave commands with the spill-over pool only. The error sentence says which limit was hit.
- **The bar failing must not break Home.** It is mounted inside an error boundary, loads its data lazily on open, and shares no state with the directory except the `changed` signal.

## Complexity Tracking

No constitution violations to justify. Two additions are worth naming because they go beyond "reuse what exists": the `command_undo` table (the spec's own carve-out, rejected alternatives in research §6) and the manifest `commands` key (needed for the shortcut; no permission).
