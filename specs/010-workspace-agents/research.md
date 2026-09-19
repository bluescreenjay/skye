# Research: Workspace Agents

Decisions for feature 010. No `NEEDS CLARIFICATION` remained after `/speckit-clarify`; this file records the design choices the plan rests on, with what was rejected. Section numbers are referenced from `plan.md`, `data-model.md`, and the contracts.

## 1. Run lifecycle: a stored "pending" run, one guard in the database, a background job

- **Decision**: Pressing an agent inserts a run row with status `pending` (shown to clients as `running`) and returns `202` at once. The work runs as a background job in the same server process and finishes the row as `succeeded` or `failed`. The card re-reads state (spec FR-039, FR-040).
  - **One at a time per workspace agent** is enforced by the database: a partial unique index on `(user_id, workspace_id, action_id) WHERE status = 'pending'`. A second insert fails with unique-violation `23505` and becomes `409 run_in_progress`. This is the same pattern feature 004 uses for clustering runs (`cluster/run.ts`), so two presses at the same instant can never both start.
  - **Stale runs**: before inserting **and on every read of a workspace's agents or runs**, any `pending` run older than 120 s (`STALE_RUN_SECONDS`, the same number clustering uses) is marked `failed` with the fixed reason `timed_out`. The job's own finish step only writes `WHERE status = 'pending'`, so a job that finishes after it was reaped changes nothing (including plan items). This covers a server restart (FR-011).
  - **The job** is a tracked promise (a small registry on `globalThis`, like the budget, limiter, and chat lock), started with `void`. The registry lets tests wait for all jobs to finish. There is a hard limit of 50 s on the whole job.
- **Rationale**: The description requires the run to survive the person leaving the card, and a 45 s wait on one HTTP request is fragile (a closed panel or a network blip loses it). A stored row is the only thing both the card and a test can read to learn the truth, and it needs no new table.
- **Alternatives considered**:
  - *`after()` from Next.js*: it needs a live request scope and throws when route handlers are called directly, which is how every test in this repo calls them. It is also aimed at serverless hosts; this project runs on one long-lived Node process (the same assumption 008's reply lock records). A plain tracked promise works in both.
  - *A job queue or worker*: a second process and new infrastructure for at most a few runs at a time. Rejected by Constitution IV (least power).
  - *Wait on the request (the rejected clarify option B)*: simpler, but loses runs and cannot show "running" after a reload.
  - *In-memory lock only*: forgets on restart and cannot be seen across requests after the process reloads in dev; the database row is durable.
- **Known limit**: one server process. Several processes would still be safe for "one at a time" (it is a database index) but a job would only be reaped after 120 s if its process died. Recorded in the plan's risks.

## 2. Reading pages: a small transport that connects only to addresses it has checked

- **Decision**: A purpose-built reader (`src/agents/pages/`) using Node's own `https` module, not the global `fetch`, because the safety rule must apply to **the address the socket connects to**, and `fetch` gives no hook for that.
  - **Before any request**: the URL must be `https:`, port 443 (or none), no user-info (`user:pass@`), a hostname that is not an IP literal, and not `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.lan`, `*.home.arpa`, or a single-label name. Failing any of these is `private_address` (or `not_secure` for `http:`).
  - **At connect time**: a custom `lookup` resolves the name with all addresses and **refuses if any resolved address is not a public internet address**; otherwise it hands the socket one of those already-checked addresses. Because the socket connects to the address that was checked, changing DNS between the check and the connect (DNS rebinding) cannot redirect it.
  - **Non-public ranges** are held in a Node `net.BlockList`: IPv4 `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16` (includes cloud metadata `169.254.169.254`), `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`; IPv6 `::`, `::1`, `::ffff:0:0/96` (checked as the embedded IPv4), `64:ff9b::/96` (NAT64, embedded IPv4 checked), `100::/64`, `2001::/32`, `2001:db8::/32`, `2002::/16` (6to4), `fc00::/7`, `fe80::/10`, `ff00::/8`.
  - **Redirects** are followed by hand, at most 2, and every hop goes through the same checks (so a redirect to a private or `http:` address is refused).
  - **Requests send nothing personal**: no cookies, no authorization, a fixed `User-Agent`, `Accept: text/html,application/xhtml+xml,text/plain`, and the environment's proxy settings are not used (Node's `https` ignores them).
  - **Limits** (defaults in `src/agents/limits.ts`, each overridable by an environment variable): 8 pages per run, 8 s per page, 12 s for the whole reading step (pages read 4 at a time), 500,000 bytes per page after decompression (the reader stops reading at the cap and reports `too_large`), 4,000 characters of text kept per page, 30,000 across the run.
  - **Compressed bodies** are accepted (`gzip`, `deflate`, `br`) but decompressed through a size-capped stream, so a compression bomb hits the byte cap instead of memory.
- **Rationale**: Reading pages is the riskiest part of the feature (spec User Story 3): the server would otherwise fetch addresses a person, or a page's redirect, chooses. Checking the connect address, not just the URL text, is the part that survives redirects, odd hostnames, and rebinding.
- **Alternatives considered**:
  - *Global `fetch` with a URL check*: a hostname that resolves to a private address, or rebinds after the check, gets through. Rejected as unsafe.
  - *A library (`ssrf-req-filter`, `got` with hooks, `undici` interceptors)*: each adds a dependency and hides the logic that most needs testing. The needed logic is about 150 lines and table-testable.
  - *A hosted "reader" API*: sends the person's page addresses to a third party; against the privacy rules of the feature.
  - *Headless browser*: would read app-style pages, but is exactly the heavyweight tool Constitution IV rules out and is a far larger attack surface.

## 3. Why the address is stripped, and what that costs (clarify Q2)

- **Decision**: Pages are requested at the tab's address **without query string and fragment** (`stripUrl`-style, but with no length cap applied to what is requested). The result flags any page whose address was stripped (`trimmed: true` in its source note), and if the plain address gives a different or empty page the tab shows as `no_text` or `error` rather than being described.
- **Rationale**: Query strings carry session tokens, magic links, and one-time actions; requesting them from the server would replay them. The cost is real: pages that need their parameters (a video watch page, a search result) will not read. That is accepted and reported plainly.
- **Alternatives considered**: full address (replay risk), or "strip only when it looks secret" (a guessing rule that can be wrong in the dangerous direction). Both rejected in clarify.

## 4. Turning a page into text without a dependency

- **Decision**: A small extractor (`extract.ts`, roughly 100 lines): remove comments, `script`, `style`, `noscript`, `template`, `svg`, `iframe`, `head` (keeping `<title>`); if a `<main>` or `<article>` exists use its contents, otherwise `<body>`; drop `nav`, `header`, `footer`, `aside`, and `form` blocks when not inside `main`/`article`; turn block-level tags into line breaks; strip the remaining tags; decode the common entities (named ones for quotes, ampersand, angle brackets, non-breaking space, dashes, and all numeric `&#N;` / `&#xN;`); collapse whitespace; cut to the per-page cap. A result under 200 characters is treated as `no_text` (app pages, login shells, video pages) and the tab falls back to its stored excerpt.
- **Rationale**: Good enough for articles, documentation, and papers (the target), fast, and testable with fixtures. It also makes prompt injection easier to contain: the output is plain text, never markup.
- **Alternatives considered**: `cheerio` or `@mozilla/readability` + `jsdom` (better extraction, but a dependency tree and a parser attack surface for a hackathon-week feature); regex-only stripping of all tags (keeps menus and cookie banners, which is the failure the person already saw with the Canvas tab).

## 5. Telling a page that needs sign-in from an ordinary error

- **Decision**: `401` and `403` are `needs_sign_in`. A redirect whose destination path or host contains `login`, `signin`, `sign-in`, `sso`, `auth`, `cas`, `oauth`, or `saml` is `needs_sign_in`. A `200` HTML page that contains an `<input type="password">` and under 1,500 characters of text is `needs_sign_in`. Everything else that fails is `error` (4xx/5xx other than the above), `too_slow` (timeout), or `too_large`.
- **Rationale**: The person's real case is a course site; "needs sign-in" is the useful, honest reason. The heuristics only choose which fixed sentence is shown; nothing is inferred about content.
- **Alternatives considered**: reporting every failure as `error` (less helpful); trying to log in (out of scope, forbidden).

## 6. What the model is given and how it answers

- **Decision**: One request per run through the shared AI layer (`generateJson`, purpose `actions`, default model `gpt-oss-120b` on the default provider, overridable with `LLM_MODEL_ACTIONS`).
  - **Prompt** = fixed rules for this agent, then **one JSON data block** holding all untrusted text (the workspace name, tabs with short ids `t1..tN`, page text by tab id, plan items, recent chat), exactly the defence 008 uses (its research section 7). The rules say the data is content to read and never instructions; the agent cannot act; answer in the language the material mostly uses.
  - **Tabs listed**: up to 40 (open first, then most recently seen), title 200, plain address 200, excerpt 400 (excerpt only when no page text was read for that tab). **Chat**: the last 20 messages up to 24,000 characters, by importing chat's own `fitHistory`/`recentTurns` (spec FR-041). **Plan items**: up to 30.
  - **Structured answers**: each agent has its own strict JSON Schema (data-model.md, "Answer shapes"). Tabs are cited by short id; the server maps ids back to title and plain address. Unknown ids are dropped.
  - **Server-side validation**: text is capped and must be non-empty; comparison rows must match the number of criteria; checklist has 1 to 8 items of at most 200 characters; **every quote must appear (after normalizing case, whitespace, and quote/dash characters) in the material of the tab it cites, or it is dropped** (spec SC-003). A quotes run with none left succeeds with an empty list and a plain note; any other unusable answer fails the run as `bad_answer`.
  - **Time and size**: `generateJson` gets a new optional `deadlineMs` (default unchanged at 25 s); agents pass 30 s, and `maxTokens` 3,000. Reading (at most 12 s) plus the model (at most 30 s) keeps a run within the 45 s target (spec SC-001) with the job's 50 s cap as backstop.
- **Rationale**: Reuses the provider interface, the concurrency limiter, the budget, and the injection defence rather than building parallel ones. Verifying quotes on the server is what turns "collect refs" from plausible into trustworthy.
- **Alternatives considered**: streaming (the spec says the whole result appears at once, and structured answers cannot be shown half-built); one free-text answer for all agents (cannot be verified or tabulated); two model calls, one to pick pages and one to answer (breaks "one request per run").
- **Counted the same way as 008**: the "one model request" is counted at the agent-model seam (one call per run); the AI layer's own retries for a busy service are counted against the daily allowance, not against the rule.

## 7. The "next steps" checklist and plan items (spec FR-015 to FR-018)

- **Decision**: On success the job, in **one transaction**: (1) marks the run `succeeded` (only if still `pending`; otherwise it rolls back and writes nothing), (2) keeps the workspace's ticked plan items in their order, (3) deletes its unticked ones, (4) inserts the proposal after them, trimmed so the total is at most 30. The run's stored output keeps a copy of the proposed items so an older run shows what it proposed (spec User Story 7); only the current plan items are tickable.
- **Ticking** is a single update of one plan item, scoped by user and workspace. There is no manual add, edit, reorder, or delete in this feature.
- **Chat integration** needs no change: 008's `buildContext` already reads plan items (limit 30, with `done`) into its data block, so the same ticks show up in chat (spec SC-010).
- **Alternatives considered**: appending forever (the list would grow without bound); replacing everything (would silently drop ticks); a separate checklist table (the spec says to avoid new tables and 008 already reads `plan_items`).

## 8. Failures, messages, and the AI allowance (spec FR-031, FR-032)

- **Decision**:
  - The AI layer's typed errors are turned into a fixed situation (`unconfigured`, `busy`, `quota`, `daily`, `vpn`, `generic`) by one small function, `src/llm/situation.ts`, extracted from what `chat/errors.ts` already does. Chat and agents both use it; each writes its own sentences (chat's end with "Your message is saved."; agents' end with "You can run it again.").
  - **Before a run exists**: no key configured → `503 model_unconfigured` and nothing is stored (same as chat); no readable tabs → `409 no_tabs`, no AI request. **After a run exists**: every AI failure marks the run `failed` with `{ code, message }` (fixed sentences only, never the AI service's text).
  - **Budget**: the never-used `plan` purpose is removed and its share moves to `actions` (80 becomes 120; the daily cap of 450 is unchanged). The `Purpose` type, `SHARES`, the VT default-model table, and their tests change accordingly. A per-workspace-agent press that finds the allowance spent fails as `budget_exhausted` (daily) without an AI request.
- **Rationale**: One classification means chat and agents cannot drift apart on what "busy" or "VPN" mean, and the fixed sentences keep vendor text out of stored rows.
- **Alternatives considered**: copying `friendlyLlmError` into agents (two places to fix); returning AI failures synchronously (the run is asynchronous, so the failed row is the single source of truth).

## 9. Keeping load and history bounded (spec FR-043 and the clarify deferrals)

- **Decision**: 
  - **History**: after every finish (success or failure), delete a workspace agent's runs beyond the newest 10, except any `pending` run and the newest `succeeded` run (so a string of failures cannot push out the last good result).
  - **Per person**: at most 3 runs `pending` at once (`429 too_many_runs`); with one-at-a-time per agent and five agents this is a soft cap that stops one person filling the server.
  - **Per process**: a semaphore of 8 concurrent page downloads across all runs; waiting counts against the 12 s reading step.
  - **AI**: the existing limiter (`8` for the default model family) already queues model calls; nothing new.
- **Rationale**: These numbers answer the two items `/speckit-clarify` deferred to planning. They are defaults in one file and can be changed without touching behavior.

## 10. Index-only schema change

- **Decision**: `packages/shared/sql/010_agents.sql` adds only indexes: the partial unique "one running run" index, a lookup index for `action_runs` by `(user_id, workspace_id, action_id, created_at DESC, id DESC)`, and a lookup index for `plan_items` by `(user_id, workspace_id, sort_order, id)`. No table and no column. It is idempotent and applied with the existing `apply-sql.mjs`.
- **Rationale**: Matches the spec (FR-014) and the way 008 handled its one index.
- **Alternatives considered**: a `finished_at` column (the start time is enough for ordering and staleness); a `result` table (more moving parts than one JSON column).

## 11. Home card: layout, polling, and reuse by the sidebar

- **Decision**:
  - **Layout**: the expanded card's three bands become tabs | chat (`WorkspaceChat`) | agents (`AgentsColumn`). The `ACTIONS` stub buttons and the `band-artifacts` column are removed from `Home.tsx`.
  - **State**: one read of `GET .../agents` per open card, then every 3 s **only while some agent shows `running`**, stopping when none does (spec FR-040). Ticking a checklist item updates the screen at once and is saved with `PATCH`; a failed save puts it back and shows a short note.
  - **Server unreachable** (spec FR-038): the card keeps whatever it already shows, adds one short plain note ("could not reach the server", the same wording Home's organize control and the chat panel use), stops polling, and offers no fake results; the next successful read clears the note.
  - **Rendering**: results are drawn as plain text elements only (paragraphs, table cells, list rows); a quote's tab title opens the tab's own address through the existing open-tab behavior on click; nothing loads remotely (spec FR-028).
  - **Reuse**: `agents.ts` (client and pure helpers) and `AgentsColumn.tsx` import nothing Home-specific, so the sidebar (006) can mount the same component; they live in `apps/extension/src/ui/`, the folder feature 006 created for components that Home and the sidebar both use (`TabMark`, `TabRow`), with the component's own stylesheet imported by the component itself (Constitution V: shared components, not forked). The host passes in how to open a tab, so the shared code never touches `chrome.tabs` (the observe-only test scans every folder except `home/` and `sidebar/`). *(Updated during task generation: the plan first placed these under `src/home/`, before 006's shared folder existed on `main`.)*
- **Rationale**: Mirrors how the chat panel was added, so the structure and the tests are familiar.
- **Alternatives considered**: a push channel (server-sent events) for run state (the spec chose start-then-check-back); polling always (wasted requests on idle cards).

## 12. Testing approach

- **Decision**: Vitest on PGlite, no network, no key, like 003, 004, and 008:
  - `agents-pages.test.ts`: the address rules table-tested (every range above, IPv4-mapped IPv6, odd hostnames, credentials, ports); the transport tested with an injected connector for redirects, hop re-checks, size and time caps, content types, sign-in detection, and compression caps; extraction tested with HTML fixtures (article, docs page with nav, login shell, app shell, hostile text); and one real-socket test that a loopback HTTPS listener **receives no connection** when its address is requested.
  - `agents.test.ts`: routes and lifecycle with a fake agent model and a fake page reader: each agent, next-steps plan items, isolation, injection, failures, one-at-a-time, per-person cap, stale reaping, retention, no logs, no AI request without a press.
  - `agents-validate.test.ts`: the answer validation (quote verification especially).
  - `agents-live.test.ts` (opt-in, `AGENTS_LIVE=1`): real provider, fixture pages served from a local listener through an injected connector (the reader's public-address rule would otherwise refuse a local server), scoring SC-002, SC-003, SC-008, and timing.
  - Extension: `ui-agents.test.ts` for the pure client helpers (poll decisions, tick optimism, result-to-view mapping).
- **Mutation checks** (as in 008): temporarily weaken the address check, the quote verification, and the log line to confirm the tests fail.

## 13. Cross-feature effects (to flag, not silently make)

- **005 spec**: FR-004 and FR-006 describe the actions and artifacts columns as stubs; this feature replaces them. Note in that spec, do not rewrite it.
- **008**: its Assumptions still say plan items arrive "once plan generation (feature 009) ships". Stale by one line; the plan lists it for the person to decide.
- **004/008 research** mention `LLM_MODEL_PLAN` and the plan share; those lines change with the budget edit.
- **Constitution and FEATURES.md** were already updated (v1.4.0); nothing further.
