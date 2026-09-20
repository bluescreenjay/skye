# Research: Global Command Bar

Decisions for the plan. Each has the choice, why, and what was rejected. Section numbers are referenced from [plan.md](./plan.md), [data-model.md](./data-model.md), and [contracts/](./contracts/).

## 1. One AI request per submit, and the model never writes what the person reads

**Decision.** Submitting a command makes exactly one `generateJson` call (purpose `command`, model `gpt-oss-120b-thinking-low` by default; the purpose and its model already exist in `src/llm/`). Its answer is a **structured intent** (a fixed enum plus ids and a few short fields, [contracts/model.md](./contracts/model.md)). Every sentence the person sees is a fixed template in one file (`src/command/messages.ts`) filled with values the server has checked (counts, workspace names from the database, tab titles from the database). The only model-written strings that ever reach state are a new workspace **name** (checked like clustering's names) and, for a compound command, `parts` that must be verbatim substrings of what the person typed.

**Why.** FR-004, FR-006, FR-021, and FR-022. A model that writes prose can be steered by a tab title into writing a convincing lie; a model that only picks from a menu can only pick a wrong menu item, and every wrong pick that changes something is caught by the confirmation step (section 2). Fixed templates also make the "what I understood" line (FR-009) testable without a model.

**"One request".** SC-008 counts the bar's own request: one call to `generateJson` from `interpret`. The shared provider code retries a transient "busy" answer inside that one call, exactly as it does for clustering and agents; the bar never re-submits (FR-028). Tests count calls on the `CommandModel` seam, so they measure exactly what the spec measures.

**Rejected.** Letting the model write the reply (injection surface, untestable); a rule-based pre-router that skips the model for easy commands (a second decision-maker that must agree with the first; the spec wants one request per submit anyway); several small requests (interpret, then pick tabs, then name) (breaks FR-004 and SC-003).

## 2. Two server calls: `interpret` (no side effects), then `apply` (the server decides whether to confirm)

**Decision.** `POST /api/command` interprets and **changes nothing**; it returns a reply the client shows or acts on. Anything that changes state is a second call, `POST /api/command/apply`, with the resolved action and `confirmed: true|false`. The **server** decides whether the action needs confirmation, from the action and the current state, and answers `needs_confirmation` with the exact list of changes when it does and `confirmed` was not sent. Nothing moves, renames, merges, or closes without a request that says `confirmed: true`.

**Why.** FR-018 and SC-006 are about "nothing changes without a separate confirmation showing exactly what will change". Putting the check in the server, on the current state, means it holds even if the client has a bug or the state changed between typing and confirming (edge case: "resolves against the current state"). It also makes the choice buttons uniform: a choice is just an action, and it goes through the same `apply`. Interpret can be tested with no database writes at all.

**Confirmation rules (server).**

| Action | Needs confirmation |
| --- | --- |
| `organize`, `cleanup` (its organize step), `undo`, `agent` (a press) | never; organize and undo are undoable or read-only in effect, and an agent press changes no tab |
| `group`, `move`, `rename`, `merge` | always |
| `create` | only when the set includes a tab the person placed themselves (`placement_source = 'user'`, including tabs deliberately kept in Other); a set of never-placed tabs runs at once with Undo (User Story 2) |
| closing duplicate tabs | always, and it is done by the extension (section 7) |

**Rejected.** Preview computed at interpret time and trusted at apply (goes stale, and the client would decide what needs confirming); a signed preview token (extra machinery; the check-on-apply is enough because the caller is the person's own paired device).

## 3. What the model is given, and how names are matched

**Decision.** One prompt: fixed rules, then one JSON data block ([contracts/model.md](./contracts/model.md)). The block holds the command text, today's local date and weekday, the surface (`home` or `page`), up to **40 workspaces** (short id `w1…`, name), and up to **150 tabs** (short id `t1…`, title cut to 100, address without query string or fragment cut to 100 (the `stripUrl` rule clustering uses), excerpt cut to 100, and the short id of the workspace it is in or `null` for Other). Live tabs come first, then the most recently seen. Tabs in archived workspaces are left out (so find never searches them). Real ids never go to the model; a short id that maps to nothing is dropped.

**Workspace names are matched by asking the model for every plausible match, then applying the spec's rule in code.** The model returns the *list* of workspaces a phrase could mean (`subject`, `destination`), best first, plus a flag saying whether the person named one at all. The server then does FR-007: one match resolves; two or more become a question with a button per match; none, when one was named, is said plainly with the person's workspaces listed. "This workspace" is resolved from the request's context by FR-008 (section 5), never by the model.

**Why.** The model is good at "my trip planning" meaning "kyoto trip"; it is bad at admitting doubt, so we do not let it pick when two fit. Deterministic name matching alone would fail on paraphrase.

**Size.** Worst case about 48,000 characters (about 12,000 tokens), comparable to feature 010's biggest prompt. Over 150 tabs, the rest are not visible to the model; the reply says "looked at your 150 most recent tabs" only when that cut happened (never silent, FR-027's spirit). Deadline 20 s, at most 900 answer tokens.

**Rejected.** Sending only workspace names and fetching tab titles in a second request when needed (a second AI request); sending real ids (leaks identifiers, invites made-up ones); full page text (FR-035 forbids reading pages).

## 4. The intent set, doubt, and refusals

**Decision.** The interpreter's `intent` is one of: `organize`, `cleanup`, `group`, `move`, `rename`, `merge`, `create`, `show`, `open_workspace`, `find`, `recall`, `undo`, `agent`, plus three non-actions: `clarify`, `multiple`, `unsupported`. That is exactly FR-005's list. Anything outside the enum fails validation and becomes "can't do that" (never an action). The interpreter also returns `confidence` (0 to 1): **below 0.6 is treated as `clarify`**, with a plain "I wasn't sure" and the list of what the bar can do (FR-010).

- `multiple` carries `parts`: at most 3 pieces of the person's own text. Each must appear (case-insensitively) inside the typed command and be at most 120 characters, or it is dropped. Each becomes a button that **submits that part as a new command** (a new submit, so a new request; nothing ran before it).
- `clarify` between intents carries `alternatives` chosen from a fixed set (`organize`, `cleanup`, `create`, `show`); the server maps each to a fixed phrase ("organize my tabs", "clean up my browser", …) and the button submits that phrase. Ambiguity between *workspaces* is different: those buttons are resolved actions (section 3), no new request.
- `unsupported` has a `reason`: `page_content` (asking what is inside a page, FR-035 last rule and User Story 8 scenario 7) gets a fixed sentence that offers to find the tab; anything else gets "I can't do that" plus the list.
- Asking for a 010b tool ("add this to my calendar") or computer use is simply `unsupported` (FR-022); nothing in the interpreter's enum can name one.

**Why.** A closed enum plus a doubt threshold is the whole safety story for "never surprising" (User Story 6). Fixed alternative phrases and verbatim parts keep model prose out of buttons.

## 5. Where the bar lives, and how the shortcut gets there

**Decision.** One shared component, `apps/extension/src/ui/CommandBar.tsx` (constitution V), mounted in two places:

- **Home**: Home's own URL bar is the bar. The text box is the URL bar at the top of Home and the answer drops down under it. (Changed from an overlay at the person's request during implementation: the bar belongs where the person already looks to type.)
- **A web page**: the **Side Panel** (the place the product already uses for in-page use). The bar sits at the top of the panel as an overlay over its content, so it is the same component and same behavior; the panel is narrow (about 360 px), so the bar's layout is single-column.

A content-script overlay was rejected: the manifest deliberately has no `content_scripts`, `web_accessible_resources`, or all-URL host access beyond what ingest needs (`manifest.test.ts` asserts it), a page's own CSP and styles can break an injected overlay, and it would add a second UI stack. The Side Panel needs no new permission.

**Shortcut.** The manifest gains one `commands` entry, `open-command-bar`, suggested key `Ctrl+K` (default) and `Command+K` (mac). Chrome's docs list no reservation for it; if something else already owns it, Chrome simply leaves it unassigned, the person can set it at `chrome://extensions/shortcuts`, and the visible control always works (FR-001). The handler is the only place `chrome.sidePanel.open` is called for this feature, and it calls it **synchronously first** (Chrome accepts a `commands` shortcut as the user gesture, but not after an `await`):

1. `onCommand(command, tab)` gives the active tab.
2. Web page (eligible URL, not incognito): call `chrome.sidePanel.open({ tabId })` at once, then write the open request.
3. Home: write the open request; Home is already visible.
4. Anything else (a `chrome://` page, a blank tab): open Home in a new tab with the request set (the background passes its own `openHome` in, because only `background.ts` may create tabs, per `observe-only.test.ts`).

**Signals between extension pages.** Home, the panel, and the worker share `chrome.storage.session` (no new permission). One key, `command.signal`, holds `{ kind: "open" | "changed" | "navigate", …, at }`. A page reacts to `storage.onChanged` and also, on mount, to a signal younger than 3 seconds (a panel that was just opened has not loaded yet when the request is written). `open` toggles the bar (FR-003: the shortcut again closes it). `changed` makes Home and the sidebar reload (FR-025, SC-004). `navigate` brings Home forward with a card expanded (FR-015).

**Also:** a visible "⌘K" button on Home (next to organize) and in the panel header.

**Risk recorded.** If a Chrome build refuses `sidePanel.open` from the shortcut, step 2 falls back to step 4 (open Home with the bar), and the panel's own button still works. A manual check on a real Chrome is in the quickstart.

## 6. Undo: one row per person, guarded, expiring

**Decision.** The undo handle for the single most recent change is one row in a new table, `command_undo` (primary key `user_id`, so there is **at most one row per person**). A changing command replaces the row; Undo deletes it; a read or write ignores and removes a row older than **10 minutes**. No sweeper job. It holds only ids, counts, the old name for a rename, and a one-line summary ([data-model.md](./data-model.md)). It is the "one extra thing" FR-030 and the Assumptions allow.

**Why server-side and not `chrome.storage`.** It survives the panel closing, the worker sleeping, and the bar being opened from the other surface (FR-019, User Story 6 scenario 8); the guards below need the database; "server decides" (constitution II). A client-held handle would also have to carry the inverse of every move and send it back, which lets a stale client rewrite the person's tabs.

**What Undo reverses, and its guards** (same shape as feature 004's undo):

- *organize / clean-up*: `undoRun(userId, runId)` from `src/cluster/undo.ts`, unchanged. It already reverts only tabs still AI-placed where the run put them and archives only workspaces the run made that are still empty and untouched.
- *move, group, merge, create*: each moved tab is put back **only if it is still where the command put it and still `placement_source = 'user'`**, with its old workspace and old placement source restored. A tab the person has since moved is left alone and counted as "kept where you put it". A `reassigned` event is written for each reversal.
- *rename*: the old name comes back **only if** the workspace still has the name the command gave it and no other active workspace has the old name now.
- *create*: after the moves are undone, the new workspace is archived **only if** it is empty and untouched (`updated_at = created_at`), the exact rule of 004's undo. Nothing is deleted.

**Known limit.** State equality cannot tell "the command moved tab X to B" from "the command moved it to B, the person moved it to C, then back to B"; the second is reverted. The same limit exists in 004's undo, and tab moves leave no per-move timestamp to do better. Recorded, not solved.

**A spec wording conflict, flagged.** FR-020 says the bar MUST NOT archive a workspace; User Story 2 scenario 5 says Undo "removes the workspace". This plan treats **Undo of the bar's own create** as reversing that command using 004's archive-if-empty-and-untouched rule (data kept), and FR-020 as governing what a *person's command* may ask for. It needs a one-line clarification in the spec; it is not edited here (CLAUDE.md: flag, don't change).

**Key Entities wording, flagged.** The spec says "this feature adds no new kind of saved record"; the Assumptions carve out "what Undo needs for the most recent change, held for up to 10 minutes". `command_undo` is that carve-out, so it is the one new table. The alternatives (client-held handle, reusing `cluster_runs` for everything) are rejected above.

## 7. Organize, clean up, and where duplicates are found

**Decision.** `organize` and the organize step of `cleanup` call `runClustering(userId)` **in the same process** (the function `POST /api/cluster/runs` calls), so FR-011's "exactly as Home's one-click organize" is literally the same code: same candidates (only never-placed tabs in Other), same confidence bar, same run record, same `409 run_in_progress`. Its typed errors map to the command's own fixed sentences. When the run applied at least one tab, the handle `{ runId }` is recorded; when it applied nothing, the previous handle is left alone (no change was made, FR-019).

**Duplicates are found in the extension, not on the server.** `tab_refs` has one row per address ("two tabs on the same page share one record", `src/ingest.ts`), so the server cannot see two open tabs of one page. After the organize step, the client scans **live tabs** with `chrome.tabs.query`, groups **exact address matches** (whole URL string equal, fragment included: a single-page app's `#/a` and `#/b` are different pages), and proposes closing the extras. Which copy stays: the **active** one, else a **pinned** one, else the **first** in window and tab order. A pinned tab is never a candidate to close. The person sees the list (title, and how many copies) and confirms; the extension re-checks each tab (`chrome.tabs.get`, address still equal, not incognito) and closes only those; a tab that changed is skipped and counted. This code lives in `apps/extension/src/home/close-duplicates.ts` because `observe-only.test.ts` allows `chrome.tabs.remove` only under `home/` and `sidebar/` (the same reason `closeHomeTab` lives in `home/navigation.ts`). The sidebar imports it, as it already imports `home/navigation`. Closing is not undoable (FR-019 covers moves only); the confirm list says so.

**Rejected.** Duplicate detection from `tab_refs.chrome_tab_id` (blind to the second copy); closing on the server (it cannot); auto-closing without the list (FR-014, FR-018).

## 8. Restructuring changes: one transaction each, same rules as by hand

**Decision.** `src/command/changes.ts` implements `group`, `move`, `merge`, `create`, and `rename` as set-based statements in one transaction, holding one advisory lock per person (so two changing commands cannot interleave and the undo row is consistent). Each returns exactly what changed and the prior state, from which the undo row is built.

- **Placement.** Sets `workspace_id` and `placement_source = 'user'` (spec: "recorded as the person's own placement, like a drag"). When a moved tab was `ai`-placed and its workspace changes, a `corrections` row is written (`recordCorrection`), as the existing `PATCH /api/tab-refs/:id` does, so principle III's feedback signal is kept. A `reassigned` tab event is written per tab (the existing `recordReassignments`), which recall ignores (section 10).
- **Which tabs.** Only tabs that exist, belong to the person, and are not already in the destination. Missing or already-there tabs are skipped and counted; the outcome says "moved 4, 1 was already there". A tab that has since *closed* but whose record persists still moves: membership is durable (constitution I) and the record is the saved tab. (The spec's "only the tabs still there move" is read as "only the tabs that still exist and are not already there".)
- **Names.** 1 to 80 characters after trimming, compared with trim and case folding among the person's **non-archived** workspaces (the rule `findExistingWorkspace` uses), and `Other` is reserved (`isReservedName`). Rename may change only the case of its own name. The name is stored **as the person gave it** (FR-013, FR-033); the Home UI already shows names lower-cased, so nothing looks different.
- **Merge** moves *only tabs*: every `tab_refs` row of the source goes to the destination. The source row, its chat, plan items, and agent runs are not touched, and it is not archived (FR-034). It has no tabs, so Home shows no card for it by Home's own rule; the message says the old workspace still exists. Merging into itself is refused before anything runs.
- **Group** picks its target in this order: the one destination the interpreter matched; else an existing workspace with the model's name (`findExistingWorkspace`); else a new workspace with that name. **Create** with a name already in use makes nothing and offers to add the tabs to the existing one instead (a `move` action, so it confirms).
- **"These tabs" for create/move** (from context, section 5 of [data-model.md](./data-model.md)): on Home, the live tabs in Other; on a page, tabs of this window that are in no workspace (the client sends this window's tab ids; the server maps them through `chrome_tab_id`). For `move`, "these" means the current workspace's tabs.

## 9. Workspace agents from the bar: the same run path, literally

**Decision.** An `agent` action is **not** applied through `/api/command/apply`. The client calls the existing `pressAgent` (`apps/extension/src/ui/agents.ts`) against `POST /api/workspaces/:id/agents/:agentId/run`, the same function and route the Home card uses, then polls `readAgents` every `POLL_MS` (3 s) until that agent is no longer running, for at most 90 s. Refusals (`no_tabs`, `run_in_progress`, `too_many_runs`, `model_unconfigured`) are the route's own fixed sentences, shown as they are; a press refused for "already running" makes no request to the AI (the route refuses before storing). The finished result is shown with `resultText` (the same plain-text renderer), cut to its first few lines, with "open workspace" (a `navigate` signal to Home with the card expanded, where the full result is). If 90 s pass, the bar says it is still running and that the result will appear on the workspace card; the run is saved by the server either way, so reloading Home shows it (SC-005).

**Why.** FR-017 and the feature's done-when say "the same run path as the Home card... not a second agent stack". Reusing the client function and the route is the most literal way to keep that true; it also means the bar cannot drift from the card when 010 changes.

## 10. Recall: plain SQL over `tab_events`, periods resolved in code

**Decision.** No continuous aggregate. `tab_events` already has `(user_id, time DESC)` indexed on both Tiger and plain Postgres, and one grouped query over one day or week is small. (FEATURES.md mentions Tiger continuous aggregates; they are an optimization this feature does not need, and they would not exist on the pivot database. Not built.)

- **Period.** The model returns a small vocabulary, never a date it computed: `today`, `yesterday`, `this_week`, `last_week`, `last_7_days`, `weekday` (the most recent such weekday strictly before today), or `date` (`YYYY-MM-DD`). The server resolves it in the client's IANA **time zone** to a `[start, end)` pair of instants (`src/command/period.ts`, handling daylight-saving days; a week runs Monday to Sunday). A future date is answered "that day hasn't happened yet"; a bad time zone is a 400.
- **Activity.** A tab counts once per `opened` or `activated` event in the period (a visit). `updated` (page loads and title changes) and `closed` are not activity, and `reassigned` (written by organize, moves, and undo) never is. Only `http`/`https` addresses count.
- **Answer.** Workspaces ordered by total visits, most active first, at most 5 (Other counts as one row), and each shows its 3 most-visited tabs (ties: most recent first). The workspace name and whether it is linkable come from the current `workspaces` row (`tab_events.workspace_id` is a snapshot without a foreign key); a workspace that no longer exists is left out, an archived one is listed without a link. No events in the period gives "nothing was recorded for {day}" (SC-010), never a guess.

## 11. Find

**Decision.** Find rides on the one request: the model returns ranked `tabs` (short ids) and `workspaces` (short ids) from the material it was given. The server keeps at most 8 tabs (with a "N more" count when the model listed more, up to 12), drops any id it does not know, and builds each row from the database: the full `TabRef`, and the workspace name or `Other`. Clicking a tab uses `focusOrOpenSavedTab` (focus if it is still open, else open the address in a new tab, as Home does); a workspace is shown via a `navigate` signal. It fetches no page and changes nothing. Archived workspaces are not in the material, so they are not searched.

## 12. Privacy, injection, and logs

- Sent to the AI service only on submit: the command, workspace names, and (address without query or fragment, title, excerpt) for at most 150 tabs. Opening and typing send nothing (FR-002, FR-029); the client has no debounce, autocomplete, or prefetch to leak a partial command.
- Untrusted text (titles, addresses, excerpts, workspace names) appears only inside the JSON data block, under rules that say it is data ([contracts/model.md](./contracts/model.md)). The rules are a defence, not the guarantee; the guarantees are the closed intent set, the id validation, the fixed sentences, and confirmation for every restructure. The residual risk (a hostile title nudging the model toward a wrong *intent*) is bounded to: an organize (undoable), an agent press (changes no tab), a find or recall (read-only), or a restructure that still shows exactly what it will do and waits for a click.
- Everything the client renders from a reply is a plain string in a React text node; never HTML, markdown, links, or images (as in 010).
- **Logs.** Nothing logs command text, titles, addresses, names, results, or model output. Only fixed labels and error class names (`console.error("[command] failed", err.name)`), the same rule as 004, 008, and 010. A test captures `console.*` across every intent and asserts none of the seeded text appears (SC-012).

## 13. Budget, model, and timing

- `command` already exists as a purpose and as a model default. Its daily share is **20** with a note to revisit at 011. One request per command, and the live checks below need dozens, so this plan sets it to **60**, taking 20 from chat (170 to 150) and 20 from actions (120 to 100), so the shares still total 400 and with the 50 spill-over equal the 450 cap. Flagged under "Changes outside this feature" in the plan (`tests/llm.test.ts` asserts the numbers).
- SC-003 (understood and started within 5 s in 9 of 10 runs): one request over about 12,000 tokens at low reasoning effort. The live check records timing; if it misses, the first lever is `LLM_MODEL_COMMAND` (already supported) and the second is shrinking the tab list.
- A failed or slow request maps through the existing `describeFailure` to the same fixed situations chat and agents use ("busy", "quota", "daily", "VPN", "generic"), each as a plain command sentence, with the typed text kept (SC-011).

## 14. Testing approach

- **Server** (Vitest on PGlite, as 004 and 010): a `CommandModel` seam with `setCommandModelForTests`; a fake that maps typed text to a scripted raw answer. A **fixture of 45 phrasings** (`tests/fixtures/command-phrasings.json`) covers every intent, ambiguous, unsupported, and compound; offline it drives the validator and resolver with scripted answers, and under `COMMAND_LIVE=1` it is sent to the real provider for SC-002. Executors run for real against PGlite; organize uses 004's fake cluster model and agents use 010's fake agent model, so no test needs the internet or a key (FR-031).
- Tests for: the closed enum and short-id validation; the confirmation table; each guard in Undo (a tab moved since is kept; a renamed workspace is not reverted; a touched created workspace is not archived; the 10-minute expiry and the replace-on-next-change rule); merge keeps the source's chat, plan items, and runs; name collisions; time-zone periods including a daylight-saving day; recall ordering and empty days; find never fetching (a fetch stub that fails the test if called); the hostile-text set of 5 styles (SC-009); the log scan (SC-012); the AI counters (SC-008: 0 for empty, 1 per submit).
- **Extension** (Vitest, pure modules + the existing chrome mock, extended with `storage.session`): `clipCommand`, the bar's reducer, `pressAgent` polling with a fake fetch, `findDuplicateTabs` (which copy stays, pinned never closed), `closeDuplicateTabs` (skips a changed tab), the signal helpers, and the command handler (`sidePanel.open` is called before any await).
- **Manual** (quickstart): the shortcut on a real Chrome, the panel opening, and the visual states.

## 15. Cross-feature effects to flag (not made silently)

Listed in [plan.md](./plan.md#changes-outside-this-features-own-files-flag-when-doing-them): the manifest test, the observe-only test's exemption, the chrome mock, the `command` budget share, the global test setup, and the two spec-wording points in section 6.
