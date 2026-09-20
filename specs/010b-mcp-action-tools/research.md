# Research: Action Tools (MCP and Local)

Decisions for feature 010b. `spec.md` has no `NEEDS CLARIFICATION` marker; this file settles the "chosen at planning" numbers, the mechanism choices the spec deliberately leaves open, and the facts that were checked against the world on 2026-09-19. Section numbers are referenced from `plan.md`, `data-model.md`, and the contracts.

## 1. Where the pieces live: a new `src/actions/` module beside `src/agents/`

- **Decision**: All server code is a new `apps/web/src/actions/` module (registry, local tools, integrations, suggestion pass, click loop, run lifecycle). It **reuses** the 010 pieces rather than copying them: the run table and its guard (`agents/runs.ts`), the safe page reader (`agents/pages/`), the workspace guard (`agents/guard.ts`), quote normalization (`agents/validate.ts`), the AI seam (`llm/`), and `describeFailure`. Tool runs are rows of `action_runs`, like agent runs, with `action_id` = the tool id.
- **Rationale**: FR-012 says "the same run record and the same reading rules as the 010 agents"; FR-043 says 010 keeps working with nothing configured. A sibling module means 010 stays untouched except at four small, listed seams (plan: "Changes outside this feature's own files").
- **Alternatives considered**: putting tools inside `src/agents/` (mixes a fixed five-agent catalog with a 30-tool registry and MCP transports; the 010 module is safety-reviewed and should not grow), or a separate service (a second process and deploy for a stretch feature; Constitution IV).

## 2. What "MCP client" means here, and what was checked

- **Facts (npm registry and web search, 2026-09-19)**:
  - `@modelcontextprotocol/sdk` is current (`1.30.0`, modified 2026-09-17) and ships `Client`, `StdioClientTransport`, `StreamableHTTPClientTransport`, and an in-memory transport pair usable for tests.
  - The old reference servers on npm are **deprecated ("Package no longer supported")**: `@modelcontextprotocol/server-github`, `-slack`, `-gdrive`. They must not be the default.
  - Still maintained: `@notionhq/notion-mcp-server` (`2.5.1`, stdio, integration token). Official hosted servers exist for Atlassian (documented as OAuth 2.1 **or API tokens**), Slack (hosted, OAuth scopes), GitHub (official server), and Google (managed remote servers for Drive and Gmail, Developer Preview, OAuth).
  - Most hosted servers are OAuth-first. A headless server process cannot run an interactive OAuth flow.
- **Decision**: One MCP client module built on `@modelcontextprotocol/sdk` (`^1.30.0`, the **only new runtime dependency**). Each integration is *a connection description supplied by the operator*, not a package this feature pins: either a **streamable-HTTP URL plus a bearer token** or a **stdio command plus environment**, read from environment variables (contracts/integrations.md). Static credentials only, plus one small token provider for Google (research 3).
- **Fixed catalog, discovered availability**: our 18 MCP-backed tools are fixed in code. Each has a **binding** naming the server-side tool it maps to (a short list of candidate names, because servers differ and rename), and a function turning our validated inputs into that server's arguments. At connect time the client calls `tools/list` and resolves each binding to the first candidate the server really offers. A tool with no matching server tool is *unavailable* and therefore never suggested. `tools/list` is used only to **confirm** our fixed bindings; it never adds a tool to the catalog or shows a server's own tools to the person (this keeps to Constitution IV: dynamic discovery is not a requirement, and spec FR-042 forbids person-installed servers).
- **Rationale**: This satisfies "MCP client" and "fake MCP in tests" (research 12) without betting the feature on a server package that is deprecated, and it makes "missing credentials or missing server" the same well-tested code path: not suggested, "connect this service" if forced.
- **Alternatives considered**:
  - *Hand-written JSON-RPC/SSE client*: session handling, resumption, and content negotiation are easy to get subtly wrong; the SDK is the reference implementation.
  - *Direct REST adapters per service, no MCP*: simplest and most controllable, but not what the feature is named for and it drops the "connect an MCP server" story. **Kept as the documented pivot**: the seam (`ToolConnector`, research 4) is exactly what a REST adapter would implement, so an integration whose MCP server proves unusable can be swapped for a REST connector without touching tools, suggestions, or UI (the Constitution's pivot rule, applied to this feature).
  - *Pinning the deprecated reference packages*: rejected on the facts above.
  - *Person-added servers*: forbidden by spec.
- **Honest limit**: the exact tool names and argument names of each real server were **not** verified against a live server at planning time (only a live account can). The bindings in `contracts/integrations.md` are best-effort from public documentation and are validated by an opt-in live probe (`ACTIONS_LIVE_<NAME>=1`, research 12) that only reads (`tools/list`) and never writes. Tasks include one small "probe and adjust the binding" task per integration.

## 3. Credentials, "connected", and who may use what

- **Decision**:
  - **Connected** for an integration means: a transport is configured (URL or command), its credential is present, and its destination is configured (contracts/integrations.md). Otherwise `missing`.
  - **Rejected** is learned, never configured: a connect or call that ends in an authentication failure marks the integration `rejected` in memory for 5 minutes (so suggestions drop it and repeated clicks do not hammer a bad token) and returns the fixed "connect this service" sentence.
  - **Owner**: `INTEGRATION_OWNER_USER_ID` names the one person (a user id, which `POST /api/session` already returns for a device token, so the operator needs no secret to configure it). Drive and Gmail tools are available to that person only. For anyone else they are excluded from suggestions and refused with a plain "not available" that does **not** reveal whether Google is connected (spec FR-032, SC-014).
  - **Team tools** (GitHub, Jira, Notion, Slack) use one shared account each for everyone (spec Q on accounts), so the person check is only "connected".
  - **Google token**: the Google servers need a short-lived OAuth access token. The operator supplies `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN` (obtained once, outside the product); a 40-line provider exchanges them for an access token at Google's token endpoint, caches it until shortly before expiry, and hands it to the transport as the bearer. No consent screen or credential entry is built (spec Assumption).
  - **Secrets** stay in environment variables, never in a table, never in logs, errors, or stored runs (FR-041). A test sets sentinel secrets and scans every produced error, log call, and stored row for them (SC-012).
- **Rationale**: One owner id is the smallest thing that makes "the owner's mailbox, nobody else's" enforceable in one function that every route and the suggestion pass both call.
- **Alternatives considered**: a per-person credential table (spec defers it; a table of tokens raises the stakes for no demo value), owner by device-token hash in env (puts a secret-derived value in config for no gain), a role column on `users` (a migration and an admin surface the spec says not to build).

## 4. The seam that makes everything testable: `ToolConnector`

- **Decision**: Every integration tool runs through one interface:
  `ToolConnector { status(): 'connected' | 'missing' | 'rejected'; available(toolId): boolean; call(toolId, args, signal): Promise<ConnectorResult> }`.
  The real implementation is the MCP client (research 2). Tests use two fakes: (a) a **real SDK client wired to a fake MCP server over the in-memory transport** (proves the actual protocol path, `tools/list` gating, timeouts, and error mapping), and (b) a scripted fake connector that records calls (used by the run-lifecycle, isolation, and injection tests, which do not need the protocol).
- **Rationale**: Spec FR-048 and SC-007 (every tool has a fake-executor test with no account and no internet). Two fakes cost little and cover both "the protocol layer works" and "the rules on top of it work".
- **Alternatives considered**: mocking `fetch` (does not reach stdio, and tests the mock), one fake only (either the protocol or the rules would go untested).

## 5. Suggestions: one AI request, chosen from what can actually run

- **Decision**: `POST /api/workspaces/:id/actions/suggest` runs one *suggestion pass*: the server computes the **allowed tool list for this person** (registry, minus unconnected integrations, minus owner-only tools for anyone else, minus tools whose preconditions fail, such as "export summary" with no saved summary), builds one prompt (fixed rules, then one JSON data block: tabs, saved summary excerpt, checklist, saved queries, connected integration names, and the allowed tools as id, one-line description, and argument names), and makes **one** `generateJson` call (purpose `suggest`). The model returns `suggestions: [{ tool, label, reason, argsJson }]`.
  - `argsJson` is a **JSON string**, parsed by the server. Strict structured-output schemas require `additionalProperties: false`, which cannot express "different arguments per tool", and a union over 30 tools would be very large and slow. A string is validated after parsing against the named tool's own schema.
  - **Server-side validation** (the model's list is a proposal, not truth): drop an unknown or not-allowed tool, drop a duplicate tool (at most one suggestion per tool, which also matches the one-at-a-time run guard), drop a suggestion whose `argsJson` does not parse or violates the tool's schema or limits, drop one whose label or reason is empty, cut label to 60 and reason to 140 characters, keep the order, and keep at most 6. **No padding**: fewer than 3 usable shows what is usable with a plain note (spec edge case). Zero usable is a failed pass (plain note, refresh button).
  - **Prefill lock (research 6)**: whatever `argsJson` supplied and passed validation is shown on the card as a plain-text preview and is *locked* at click time.
  - **No tool runs and nothing is executed in a pass**; the pass has no tools (the model interface only returns JSON).
  - **Deadline 9 s** and `maxTokens` 1,500, so 10 s (SC-001) holds even with one retry-free failure path. A slow or failed pass answers `200` with `status: "failed"` and a fixed note; it never blocks the 010 agents column (separate request, separate component state) (FR-008, FR-009).
- **Reuse and the gap (the spec allows one)**: a stored set is kept in memory per person and workspace with a **fingerprint** of the inputs (tab ids and titles, summary version, checklist, saved queries, connected set, owner flag).
  - *Open* (`force: false`): reuse the stored set when the fingerprint is unchanged and it is under **5 minutes** old; otherwise one new pass.
  - *Refresh* (`force: true`): reuse only when the fingerprint is unchanged **and** the stored set is under **30 seconds** old; otherwise one new pass.
  - While a pass runs for a card, a second call **joins** it (same promise); no second request is started (FR-007, edge case).
  - **Deviation to flag**: SC-016 says opening "makes exactly 1 AI request". With reuse the truth is "at most 1, and exactly 1 unless the same unchanged workspace was asked within the last 5 minutes". The spec's own Assumptions allow "a small minimum gap"; this is the smallest version of it that keeps a burst of card opens from becoming a burst of AI requests (also protects the 15 requests a minute Gemini backup limit). It is recorded in the plan's Risks and can be set to 0 (`ACTIONS_SUGGEST_REUSE_S=0`), which restores literal "one per open".
- **Alternatives considered**: keeping suggestions in the database (they are short-lived proposals, not history; a table for a 5-minute cache is more than it is worth), refresh on every tab change (breaks FR-007 "do not move buttons under the cursor"; the card refreshes on open, on the button, and after a successful run, never on a timer), a model-free rules engine (cannot fit "a trip" versus "a bug hunt").

## 6. The click: prefill wins, the bounded loop fills the rest

- **Decision**: `POST /api/workspaces/:id/actions/:toolId/run` with `{ args }` (the suggestion's prefilled arguments). One click is one run, and:
  1. The server validates `args` against the tool's schema for what is present. A required argument that is **missing** makes the run a **composed** run; a tool whose required arguments are all present and valid makes a **direct** run, which makes **zero** AI requests (every local tool with full arguments; a GitHub issue with title and body).
  2. **Prefilled arguments are locked**: the loop can supply only arguments the click did not carry. This is what makes "the person can see what will be used before anything external happens" (spec edge case) true: the card shows the locked arguments before the click, and a model step cannot change them.
  3. A **composed** run is the bounded loop (research 7). It ends when the button's own tool has been called once, or a limit is hit.
  4. Two argument kinds are **prefill-only**, never model-composed at click time: the **addresses to open** (`open_related_tabs.urls`) and the **recipient of a sent email** (which the person confirms anyway). Reason: an address the model composes after reading hostile page text is an exfiltration channel (`https://attacker.example/<workspace secrets>`) that opens in the person's browser. Search queries become Google URLs built by the server at a fixed host, and are shown on the card first.
  5. **Placeholders keep long text exact**: a suggestion may write `{{summary}}` in a text argument (or `{{workspace}}` for the name). The server expands it from the saved summary when it validates the suggestion, so the preview shows real text, the model never has to copy 3,000 characters within a 1,500-token answer, and pushes send the saved text unchanged ("MUST NOT invent content", FR-021).
  6. **Accepted trade-off**: text the loop composes to fill a gap in an *external* write (an issue body, a message) is not previewable before the click, unlike prefilled text. The blast radius is small and fixed: the destination is the operator-configured repository, channel, page, project, or the owner's own mailbox (a draft, or a send that needs confirmation), the created item's link is shown at once, and helper text cannot change locked or visible arguments. The suggestion pass prefills whenever it can. Recorded under the plan's Risks.
  7. **Targets are validated, not trusted**: a page to append to (Notion) and a file to share (Drive) must be an id recorded by an earlier successful run **in this same workspace** (`output.links[].id`); a GitHub issue must be a number in the configured repository; a Jira key must start with the configured project key. This is FR-033 ("an action MUST NOT choose a different destination on its own").
- **Rationale**: One rule (visible, locked prefill) answers three spec items at once: edge case on wrong prefills, FR-033, and the injection risk (SC-011).
- **Alternatives considered**: a mandatory preview-then-run second click for every external write (the spec says one click is one run, and reserves the extra confirmation for sending mail only), letting the model rewrite prefilled arguments (removes the visible-before-click guarantee).

## 7. The bounded loop: JSON steps over `generateJson`, not native tool calling

- **Decision**: Each turn is one `generateJson` call (purpose `actions`) whose strict schema is `{ step: "call" | "finish", tool: string|null, argsJson: string|null, note: string|null }`. The server, never the model, decides what happens:
  - `call` with a **helper** tool (the 5 read-only helpers: `list_workspace_tabs`, `read_public_pages`, `github_search`, `jira_search`, `notion_search`): run it, append its result (capped at 6,000 characters, inside a JSON block marked untrusted) to the next turn's data.
  - `call` with the **button's own tool**: validate arguments (locked prefill first, model values only for the gaps), run it, end the loop. This is the only write.
  - `call` with **any other tool** (a writer, a different integration's tool, Gmail search, an unknown id): **refused**, recorded in the run (`refused: [{ tool, why }]`), fed back as "refused" so the model can recover; it still counts as a turn.
  - `finish` before the button's tool was called, or output that does not match the schema, ends the run as failed (`bad_answer`): a composed run has no other way to end well than calling its own tool.
  - **Limits**: `MAX_TURNS` = 4 AI requests, at most 3 helper calls, `TURN_DEADLINE_MS` = 20 s per AI request, `TOOL_CALL_TIMEOUT_MS` = 15 s per tool call, 60 s for the whole job. Hitting a limit before the button's tool ran ends the run as failed with `step_limit` and keeps a short plain note of what the helpers found (spec User Story 2 scenario 3), never continuing on its own.
- **Why not the providers' native `tools` parameter** (FEATURES.md mentions "OpenAI-compatible `tools`"): the AI layer (`src/llm/`) exposes only `generateJson` and `streamText`. Native tool calling on VT would mean the `-legacy-tool-calling` model variants (measured to exist, with only a one-round call verified), and Gemini has a different function-calling shape. Two more provider code paths, a new concurrency-limiter family, and new budget accounting, for a loop of at most 4 turns. The JSON-step protocol works identically on both providers, is fully scriptable in tests, keeps the allowlist entirely in server code, and needs no provider change beyond one new `Purpose`. If measured quality is poor, the loop's model interface is one function (`ActionModel.step`), so native tool calling can replace it behind the same seam.
- **Alternatives considered**: MCP `sampling` or letting an MCP server drive the loop (hands control to a third party), a planner that returns the whole plan up front (cannot use helper results), unbounded ReAct (forbidden by spec).

## 8. Send-mail confirmation: two requests, one immutable message

- **Decision**: `gmail_send_message` is *two-phase* and the click **never sends**:
  1. The click makes a normal run whose result is `email_preview` `{ to (may be empty), subject, body, expiresAt, state: "unsent" }`. `subject` and `body` come from the locked prefill and/or the loop and come **only from workspace material** (spec Q on mail). The run finishes `succeeded` ("prepared, not sent").
  2. The card shows `subject` and `body` read-only and the recipient as an editable field, with **Send this message** and **Cancel**.
  3. `POST …/runs/:runId/confirm` with `{ to }` sends the *stored* subject and body to that recipient, once: the server marks the preview `sending` with a conditional update (`WHERE state = 'unsent'`), calls the connector, then records `sent` and creates the result on a second run row (`action_id = gmail_send_message`, `input.previewRunId`). A second confirm finds the state changed and is refused (`already_sent`). `POST …/cancel` sets `cancelled`. A preview older than **30 minutes** is `expired` and cannot be sent.
  4. The recipient must be one syntactically valid address (no commas, no CR/LF, no display name), so it cannot become a header-injection or a mass send. No cc, bcc, or attachments.
- **Rationale**: SC-009 ("no email is sent without the person confirming the exact recipient, subject, and body") becomes a property of one route plus a one-way state change, and the exact text is whatever the person saw because it is read back from the stored preview, not re-sent from the browser.
- **Alternatives considered**: sending from the click with a `confirmed: true` flag from the client (a bug or replay sends; no immutable text), a confirm request that carries subject and body (the sent text could differ from what was shown).

## 9. Mail is private: it is never stored and never enters a prompt

- **Decision**: `gmail_search_messages` is `effect: read` but **not a helper**, so no loop can call it, and its results are `ephemeral`:
  - The run executes **inline in the click request** (one connector call, 15 s cap) and the messages (sender, subject, date, excerpt up to 160 characters, at most 5) are returned **only in that HTTP response**.
  - The stored run keeps `{ kind: "mail_search", shown: N }` and nothing else; after a reload the card says "3 messages were shown; they are not kept" and offers the search again.
  - The mail search connector result never passes through any function that builds a prompt: a **structural guard** (a type `PrivateContent` that the prompt builders do not accept, plus a test that spies every model call's prompt for sentinel mail strings, SC-015) enforces this.
- **Spec tension, resolved toward privacy**: SC-005 says "100% of finished runs are still shown, with the same result, after reloading". FR-036 says mail content is "never saved into the workspace unless the owner saves it". A persisted run row *is* saved into the workspace. FR-036 is the stronger, safety-critical statement; the result of a mail search is the one documented exception to SC-005, and the plan records it.
- **Alternatives considered**: storing mail results encrypted (still saved into the workspace, still a leak surface for a hackathon feature), returning results through a second GET (they would have to be held server-side somewhere).

## 10. Browser intents: the extension carries out what the person just clicked, then reports

- **Decision**: Two intent kinds only: `open_tabs { urls (≤ 5), placeInWorkspace }` and `download { format: "md" | "pdf", filename }`. The server puts them in the run's stored output and leaves the run `pending` (shown "running") until the extension reports; `POST …/runs/:runId/intents/:intentId` `{ status, opened, failed, placed }` finishes the run (succeeded, partly, or failed) with a fixed sentence.
  - **Only the click's own client executes them**: the card remembers, in memory, the run ids it started in this session and executes only those runs' intents when the run comes back. A Home reload, a second window, or the poll after a restart **never** executes an intent (FR-029, spec edge case "the extension is unavailable"). A run whose intent is never reported is failed by the existing 120-second stale rule with a fixed "the browser did not respond" sentence, and nothing is claimed as opened.
  - **Opening**: `chrome.tabs.create({ url, active: false })` per address, `https:` only (the server already filtered; the extension re-checks), no existing tab is touched (FR-029). **Placing** into the workspace (FR-030) reuses feature 007: after creation the extension resolves the new tab through `/api/resolve?chromeTabId=` and moves it with the existing move call, retrying briefly because ingestion is asynchronous; a tab that could not be placed is reported `placed` below `opened` and is not a failure.
  - **Downloading**: the extension fetches `GET /api/workspaces/:id/summary/export?format=md|pdf` with the bearer token, builds a blob, and triggers a download from the extension page (no `downloads` permission is needed for an anchor download on an extension page). The route re-reads the saved summary, so the file always matches the saved text.
  - **Manifest**: no new permission (`manifest.test.ts` asserts the permission list is unchanged). The observe-only test keeps its rule that shared UI code never touches `chrome.*`: the shared component receives `executeIntents` from its host (Home now, sidebar later).
- **Alternatives considered**: a `downloads` permission and `chrome.downloads.download` (a new permission for no gain here), a service-worker relay (adds a message channel for something an extension page can do directly), executing any pending intent found on load (would open tabs from stale runs: forbidden).

## 11. Local tool details

- **Saved summary and saved queries/references live in one new table** (`workspace_notes`, data-model.md). 010 avoided a new table because it had nothing new to store; here the spec's "Saved summary" and "Saved queries and references" are new durable, workspace-owned, dedupe-able facts that chat and agents must read (Constitution I lists notes and generated content as workspace memory). Reusing `action_runs.output` would make "the current summary" a query over run history and could not enforce "no duplicates" or the caps.
- **`write_summary`** reuses the 010 `summarize` pipeline (gather, safe page reads, one AI request, validation) through an extracted function, and saves the resulting text as the summary. Same coverage line (tabs, pages that could not be read) as 010. **`write_summary` does not use the loop**: it owns exactly one AI request, so its click makes 1 request, and 0 for every other local tool.
- **Exports**: Markdown is the summary text with a title line and the coverage note (as text, not invented). **PDF** is a small hand-written writer (`tools/pdf.ts`, about 90 lines: one font, wrapped lines, pages, cross-reference table), table-tested by parsing the produced structure. Text outside Latin-1 is replaced with `?` and the run says so; a "simple text document" is what the spec asks for (Assumptions). A library (`pdf-lib`, `pdfkit`) would still need an embedded font for non-Latin text, so it would not fix the real limit and adds a dependency.
- **`compose_share_link`** produces the plain-text bundle (workspace name, up to 5 key addresses as plain addresses without query strings or fragments, a summary blurb of at most 300 characters cut at a sentence or word boundary with an explicit ellipsis). "Link" in the tool id is the id from the request; the output is text to paste, and nothing is published (spec User Story 3 scenario 4).
- **`copy_text`** returns text and the card shows a **Copy** button; the actual copy happens on that second, explicit click, because clipboard writes need a fresh user gesture and an async run finishing is not one.
- **`open_google_searches`** builds `https://www.google.com/search?q=<encoded query>` on the server for up to 3 queries (each 3 to 120 characters, plain text). It is the one place an address with a query string is produced, and the host is fixed.
- **`save_refs`** keeps each quote with its plain address and refuses a quote not found in the material of the tab it cites, using 010's normalization. The material is the tab's excerpt plus page text read (safe reader, at most the same page limits), read fresh at save time and held in the run only.
- **Duplicates** (queries, refs, plan items) use a normalized key (lowercase, collapsed whitespace, quote characters folded) with a unique index, so a duplicate insert is a no-op counted as `skippedDuplicates`.
- **`append_plan_items`** reuses `plan_items`, appends after the existing items, never touches ticked ones, and shares 010's 30-item total.

## 12. Testing approach

- **Decision**: Vitest on PGlite, no network, no key, like 003, 004, 008, and 010.
  - `actions-registry.test.ts`: every tool present with a schema and effect class; the helper set is exactly the five read-only tools (a mutation guard); no tool named `computer`/`mouse`; owner-only tools flagged.
  - `actions-suggest.test.ts`: one AI request per pass; 3 to 6 kept; unconnected and owner-only tools never appear; invalid arguments dropped; duplicates dropped; no padding; failed pass leaves the card usable; join-in-flight; reuse and gap rules; "no tool ran".
  - `actions-run.test.ts`: lifecycle with a fake action model and fake connector: direct versus composed, locked prefill, step limit, time limit, refused writer, one-at-a-time, per-person cap, reload persistence, failure sentences, no run without a click (fake timers), retention.
  - `actions-local.test.ts`: each local tool against the database (summary, exports, share bundle, plan items, queries, refs, dedupe, caps, isolation, the Other bucket).
  - `actions-pdf.test.ts`: the PDF writer's structure (header, xref offsets, page count, text present, replacement of unsupported characters).
  - `actions-mcp.test.ts`: the real SDK client against a fake MCP server (in-memory transport): connect, `tools/list` gating, binding resolution, argument mapping per tool, timeout, auth failure to `rejected`, error mapping to fixed sentences, no secret in any error.
  - `actions-integrations.test.ts`: one test per catalog integration tool through the scripted fake connector: makes exactly the intended request with the locked prefill, returns the link or id, fails clearly when unconnected or rejected (SC-007).
  - `actions-gmail.test.ts`: draft never sends; send needs confirm; confirm sends the stored message once; second confirm, cancel, expiry, bad recipient; search is inline and unstored; owner-only.
  - `actions-safety.test.ts`: two people and two workspaces (SC-010); at least five hijack styles through hostile helper output (SC-011); sentinel scan of logs, errors, run rows (SC-012); no mail sentinel in any prompt (SC-015); non-owner gets nothing of Google (SC-014).
  - `actions-live.test.ts` (opt-in, `ACTIONS_LIVE=1`): the suggestion pass and one composed run against the real provider on fixture tabs, timing SC-001 and SC-004; `ACTIONS_LIVE_<NAME>=1`: read-only `tools/list` probe of a real server, checking each binding's candidates resolve. Pace to stay under Gemini's 15 requests a minute if the backup is active.
  - Extension: `ui-actions.test.ts` (pure helpers: poll decision, "execute intents only for runs this card started", address filtering, placement retry decisions, result-to-text mapping), and the existing `manifest.test.ts` and `observe-only.test.ts` prove no new permission and no `chrome.*` in shared UI.
- **Mutation checks** (as in 008 and 010): temporarily weaken the helper allowlist, the owner check, the confirm state guard, the mail-to-prompt guard, and the log scan to confirm the tests fail.

## 13. Limits chosen at planning (the spec says "fixed small numbers")

| What | Value | Where |
| --- | --- | --- |
| Suggestions per pass | 3 to 6 shown; 6 kept | `suggest/validate.ts` |
| Suggestion pass deadline / tokens | 9 s / 1,500 | `limits.ts` |
| Reuse on open / gap on refresh | 300 s / 30 s | `limits.ts` (env override) |
| AI requests per click (loop) | 4 | `limits.ts` |
| Helper calls per click | 3 | `limits.ts` |
| One AI request in a loop / one tool call / whole job | 20 s / 15 s / 60 s | `limits.ts` |
| Helper result fed back | 6,000 characters | `limits.ts` |
| Runs going at once per person | 5 (010's 3 is raised, shared by agents and tools) | `agents/limits.ts` |
| Tabs opened per click / searches opened per click | 5 / 3 | `limits.ts` |
| Saved queries / saved refs per workspace | 10 / 20 | `limits.ts` |
| Share bundle addresses / blurb | 5 / 300 characters | `limits.ts` |
| Mail results shown / excerpt | 5 / 160 characters | `limits.ts` |
| Confirm window for a prepared email | 30 minutes | `limits.ts` |
| Text arguments | title 200, message 3,000, body 8,000, gist 20,000 characters; over the limit is **refused**, never silently cut | `registry.ts` |
| Runs kept per tool per workspace | 10 (plus the newest success), as 010 | reuse `applyRetention` |
| Stale rule | 120 s, as 010 | reuse |

## 14. Budget and the AI provider

- **Decision**: Add one `Purpose`, `suggest` (share 40, taken from `command`, 60 to 20, which feature 011 has not consumed yet), leaving the shares' sum at 400 and the daily cap at 450. Suggestion passes use the VT default `gpt-oss-120b-thinking-low` (fast structured work, like clustering) and Gemini's default for the same purpose; click loops use `actions` (`gpt-oss-120b`). Failures reuse `describeFailure` and the same fixed sentences family as 010.
- **Rationale**: Automatic passes on card open would otherwise drain the `actions` share that user-pressed runs need. A separate purpose makes the automatic cost visible in `usage()` and boundable.
- **Alternatives considered**: sharing `actions` (an idle dashboard of open cards could starve real clicks), raising the daily cap (it is sized to Gemini's free tier).

## 15. Cross-feature effects (to flag, not silently make)

- **010**: `agents/runs.ts`'s "read the workspace's 60 newest runs" must filter to agent ids, or tool runs would push agent results out of view; `insertPendingRun` takes a generic input shape; `MAX_RUNNING_PER_USER` 3 to 5; `executeRun`'s answer step is extracted into a function `write_summary` can call. Behavior unchanged for agents; existing tests protect it.
- **008 chat** and **010 agents**: the saved summary, queries, and references join their data block (spec FR-025, User Story 4 scenario 4).
- **AI layer**: one new `Purpose` (`suggest`) and its model-table entries; budget shares change.
- **005/006 Home and sidebar**: the Home card gains a suggested-actions group; the sidebar stays as 010 left it.
- **Constitution v1.4.0**: no amendment needed. Principle IV already lists MCP and multi-step agents as optional stretch. This feature sits beyond the MVP cut line, which Governance says must be justified against Principle VI; the plan's Complexity Tracking does that.
- **`CLAUDE.md`** says "don't start P1/stretch work before [the MVP cut line] ships". The spec records that this branch starts early at the requester's explicit request; the plan proceeds on that basis and repeats the flag.
