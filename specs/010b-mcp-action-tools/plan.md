# Implementation Plan: Action Tools (MCP and Local)

**Branch**: `010b-mcp-action-tools` | **Date**: 2026-09-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/010b-mcp-action-tools/spec.md`

## Summary

Put a real tool layer behind the workspace card without changing the AI provider. The server holds a fixed **registry of 30 tools** (12 local, 18 reaching GitHub, Jira, Notion, Slack, Google Drive, and Gmail through **MCP connections**). The card never shows the registry. Opening or refreshing it makes **one AI request** (a *suggestion pass*) that picks **3 to 6 tools that can actually run for this person** and prefills their inputs; the server validates every suggestion and the card draws only those as buttons. **A tool runs only when its button is clicked**: one click is one saved run, direct (no AI request) when every required input is present, or a **bounded loop** (at most 4 AI requests, 3 read-only helper calls, 60 seconds) that fills only the gaps and may write nothing except the button's own tool. Browser work (open tabs, download a file) is returned as **intents** that the clicking card carries out and reports back. Email is never sent from a click: it is prepared, shown exactly, and sent by a separate confirmation. Mail is owner-only, never stored, and never given to the AI.

Server side (`apps/web`): a new `src/actions/` module and seven routes. Shared types in `@ai-browser/shared`. One new table (`workspace_notes`) for the saved summary, queries, and references. Client side (`apps/extension`): a suggested-actions group on the Home card next to the agents, plus a Home-side intent executor. Design detail: [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), validation: [quickstart.md](./quickstart.md).

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22, Next.js 16 App Router (`apps/web`); React 19 in `apps/extension`. `apps/web/AGENTS.md` warns Next 16 differs from older versions: this feature adds only ordinary JSON route handlers (as 008 and 010 did) plus one route that returns a file `Response` with headers, all `export const runtime = "nodejs"` (the MCP SDK's stdio transport spawns processes). Before writing the routes the implementer re-reads the route-handler guide in `node_modules/next/dist/docs/` (as 010 did), and checks whether `@modelcontextprotocol/sdk` needs `serverExternalPackages` in `next.config.ts` (verified with the scratch-copy `next build --webpack` recipe, never against the user's running `.next`).

**Primary Dependencies**: `@ai-browser/shared`, `pg`, the shared AI layer (`src/llm/`), the 010 modules it reuses (`agents/runs`, `agents/pages/*`, `agents/guard`, `agents/validate`), Node built-ins, and **one new runtime dependency: `@modelcontextprotocol/sdk` `^1.30.0`** (current on npm as of 2026-09-17). The PDF writer is hand-written (about 90 lines, table-tested); no PDF library (research 11).

**Storage**: Existing Postgres (Tiger). `action_runs` and `plan_items` are used as they are. New idempotent migration `packages/shared/sql/010b_actions.sql`: **one table**, `workspace_notes`, and one index. Suggestions, integration health, MCP sessions, and the Google access token are in memory (data-model.md).

**Testing**: `tsc --noEmit`; Vitest on PGlite with an injected `ScriptedActionModel`, a **fake MCP server on the SDK's in-memory transport** (protocol path), and a scripted fake connector (rules path); table tests for suggestion validation, argument locking, address rules, and the PDF writer; one safety suite (isolation, five or more hijack styles, secret and mail sentinels in logs and prompts); extension unit tests for pure helpers. Opt-in live checks: `ACTIONS_LIVE=1` (real AI provider) and `ACTIONS_LIVE_<NAME>=1` (read-only `tools/list` probe). Nothing touches Tiger, a real service, or the internet by default.

**Target Platform**: A local Next.js server on a machine that can reach the AI provider (VT VPN for the default), the public internet (page reading), and whatever MCP servers the operator configures. Chrome extension pages call it.

**Project Type**: Web API in the existing app `apps/web` plus a UI change in `apps/extension`.

**Performance Goals**: A suggestion pass answers within 10 s (SC-001): AI deadline 9 s. A local action finishes and shows its result within 30 s in 9 of 10 runs (SC-004): direct runs take milliseconds, `write_summary` about as long as 010's summarize, a composed run at most 4 AI requests within a 60 s cap. No run shows `running` after 120 s.

**Constraints**: Every query filters by `user_id` and the workspace id. No tool runs without a click; the suggestion pass has no tools. The model can only return JSON; the server executes. Prefilled inputs are locked; addresses to open and email recipients are never model-composed at click time; targets are validated against this workspace's own earlier runs. Mail never enters a prompt or a stored row. Secrets only in the environment; never in a log, an error, a run, a response, or a prompt. Destinations come from configuration; no tool takes a destination as input. Text over a limit is refused, never silently cut.

**Scale/Scope**: About 40 tabs, 30 checklist items, and 10 saved queries of context per pass; a person has at most 5 runs going; about 10 runs kept per tool per workspace. Seven routes, one table, one shared types file, one client module, one card group, one host executor.

## Constitution Check

*GATE: Must pass before Phase 0. Re-check after Phase 1.*

| Principle | Status | How this plan complies |
| --- | --- | --- |
| I. Workspace-First | PASS | The workspace owns its runs, saved summary, saved queries, and references (workspace-scoped rows that outlive tabs and the browser; deleted only with the workspace). Every action uses only the workspace it was clicked on; the Other bucket is refused. |
| II. Extension observes and presents; server decides | PASS | The server decides everything: what to suggest, what to run, which addresses to open, what to save. The extension only executes the server's browser intents for a click the person just made (like applying workspace assignments) and reports back; it reads no page and infers nothing. It never moves, groups, or closes existing tabs. |
| III. User corrections win | PASS | Tools never move, group, close, or recategorize tabs; opened tabs join a workspace only when the person chose it, through 007's existing move. Suggestions are proposals the person may ignore; nothing is forced. |
| IV. Least-power actions | PASS (stretch, with limits) | This is exactly the "MCP servers and multi-step specialized agents are OPTIONAL stretch" the principle allows, and it **must not gate the demo**: with no connection configured the 12 local tools and all five 010 agents work unchanged, and a failed suggestion pass leaves the card usable. The tool set is **fixed in code**; `tools/list` only confirms our own bindings and never exposes a server's tools (no dynamic discovery). The loop is bounded (4 AI requests, 3 helpers), read-only except the button's own tool, and needs a click. **No computer-use, no mouse control, no person-installed servers.** |
| V. One TypeScript surface | PASS | New response types in `@ai-browser/shared/actions.ts`; `ActionRun` and `PlanItem` reused. The card group and client live in `apps/extension/src/ui/` (imports nothing Home-specific; the host passes in `onOpenTab` and `executeIntents`) so the sidebar can mount them later. |
| VI. Demo-hard, architecture-soft | PASS (justified below) | Beyond the MVP cut line; see Complexity Tracking. The provider seam is unchanged (VT ARC default, Gemini backup); a service that will not work over MCP can be swapped for a REST connector behind the same `ToolConnector` seam without a product rewrite (the pivot rule, applied here). |
| VII. Two surfaces | PASS (staged) | Home first, as agreed for 010; the sidebar reuses the same component later. Nothing server-side is Home-only. |
| Stack / secrets | PASS | No new vendor for AI. One new npm dependency (the reference MCP SDK). Credentials are environment variables only; nothing committed; nothing logged. |
| Persistence: user-scoped rows | PASS | `workspace_notes` has `user_id` and a composite foreign key onto `workspaces (id, user_id)`; `action_runs` as before. |

**Gate result: PASS** (before Phase 0).

**Post-design re-check: PASS.** Phase 1 added machinery beyond a minimal one-shot design (a second AI seam, an MCP client, a two-phase send). Each piece is tied to a specific requirement in the table below and to a risk recorded under Risks; none conflicts with a principle. Two spec tensions were found and resolved in favor of the safety requirement: SC-016's "exactly one AI request per open" (bounded reuse, research 5) and SC-005's "every finished run survives a reload" versus FR-036's "mail is never saved" (mail-search results are the one exception, research 9). Both are **flagged for the requester to accept or veto**.

## Project Structure

### Documentation (this feature)

```text
specs/010b-mcp-action-tools/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── http.md
│   ├── tools.md
│   ├── model.md
│   ├── integrations.md
│   └── shared-types.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks, not created here
```

### Source Code (repository root)

```text
packages/shared/
├── sql/010b_actions.sql                  # NEW: workspace_notes + one index (idempotent)
└── src/
    ├── actions.ts                        # NEW: suggestion, run, result, intent, and error types
    └── index.ts                          # + export * from "./actions"

apps/web/
├── app/api/workspaces/[id]/
│   ├── actions/route.ts                                       # NEW: GET summary + queries + latest run per tool
│   ├── actions/suggest/route.ts                               # NEW: POST suggestion pass
│   ├── actions/[toolId]/run/route.ts                          # NEW: POST one click (202; 200 for mail search)
│   ├── actions/runs/[runId]/intents/[intentId]/route.ts       # NEW: POST extension report
│   ├── actions/runs/[runId]/confirm/route.ts                  # NEW: POST send the prepared email
│   ├── actions/runs/[runId]/cancel/route.ts                   # NEW: POST cancel it
│   └── summary/export/route.ts                                # NEW: GET the saved summary as md or pdf
├── src/actions/                                               # NEW module
│   ├── limits.ts          # every fixed number and its env override (one file)
│   ├── errors.ts          # ActionRequestError, ToolRunError, the fixed sentences, failureFor()
│   ├── registry.ts        # the 30 tools: id, description, effect, helper, ownerOnly, schema, preconditions
│   ├── args.ts            # validate arguments against a tool schema; locked-merge; placeholder expansion; limits
│   ├── access.ts          # allowedTools(user): owner rule, connection status, preconditions (used by suggest AND click)
│   ├── model.ts           # ActionModel seam (suggest, step); getActionModel(); setActionModelForTests()
│   ├── suggest/
│   │   ├── pass.ts        # gather → prompt → one AI request → validate → store; join in flight; reuse and gap
│   │   ├── prompt.ts      # fixed rules + the one JSON block
│   │   ├── validate.ts    # per-item checks, preview building, no padding
│   │   └── cache.ts       # in-memory set + fingerprint + in-flight promise (globalThis)
│   ├── loop.ts            # the bounded loop: step schema, helper/own-tool/refuse decisions, limits
│   ├── run.ts             # click lifecycle: checks → store pending → direct or composed → finish (job)
│   ├── runs.ts            # tool-run views and reads (uses agents/runs.ts for insert/finish/reap/retention)
│   ├── intents.ts         # store awaiting intents; accept the extension's report; finish the run
│   ├── confirm.ts         # email preview state machine: unsent → sending → sent | cancelled | expired
│   ├── notes.ts           # workspace_notes: summary upsert; queries and refs with caps and dedupe
│   ├── tools/
│   │   ├── local/         # list-tabs, read-pages, write-summary, export, open-tabs, searches, save-queries,
│   │   │                  #   plan-items, save-refs, copy-text, share-bundle (one small file each)
│   │   ├── pdf.ts         # minimal text PDF writer
│   │   └── integration.ts # one generic executor: validate → connector.call → links
│   └── integrations/
│       ├── connector.ts   # ToolConnector, ConnectorError, getConnector(), setConnectorForTests()
│       ├── config.ts      # env → integration config and status; destinations; owner id
│       ├── mcp-client.ts  # SDK Client per integration; tools/list resolution; timeouts; error mapping
│       ├── google-token.ts# refresh-token exchange, cached
│       └── bindings/      # github.ts, jira.ts, notion.ts, slack.ts, drive.ts, gmail.ts
├── src/llm/
│   ├── budget.ts          # Purpose + "suggest" (share 40); "command" 60 → 20
│   └── openai-compat.ts   # default model for "suggest" (Gemini needs no change: its model choice is env-driven per purpose)
├── src/map.ts             # + mapToolRun
├── src/agents/
│   ├── runs.ts            # readEntries filters to agent ids; insertPendingRun takes a generic input (behavior unchanged)
│   ├── limits.ts          # MAX_RUNNING_PER_USER 3 → 5
│   └── run.ts             # extract produceOutput() from executeRun so write_summary reuses it (behavior unchanged)
├── src/chat/context.ts    # + saved summary excerpt, queries, refs in the data block
├── src/agents/context.ts + prompt.ts  # + saved queries and refs in the data block
├── package.json           # + @modelcontextprotocol/sdk
└── tests/
    ├── actions-registry.test.ts      actions-suggest.test.ts   actions-run.test.ts
    ├── actions-local.test.ts         actions-pdf.test.ts       actions-mcp.test.ts
    ├── actions-integrations.test.ts  actions-gmail.test.ts     actions-safety.test.ts
    ├── actions-live.test.ts          # opt-in
    ├── actions-helpers.ts            # ScriptedActionModel, fake MCP server, scripted connector, seeding, run-and-wait
    └── global-setup.ts               # also apply 010b_actions.sql

apps/extension/
├── src/ui/                 # shared by Home and (later) the sidebar
│   ├── actions.ts          # NEW: client (suggest, list, run, report, confirm, cancel) + pure helpers
│   ├── ActionsGroup.tsx    # NEW: the suggested-actions group; imports nothing Home-specific
│   └── actions.css         # NEW: its styles
├── src/home/
│   ├── action-intents.ts   # NEW: the host executor (chrome.tabs.create, place via 007, blob download)
│   ├── Home.tsx            # mount ActionsGroup beside AgentsColumn
│   └── home.css            # layout for the new group
└── tests/ui-actions.test.ts

.env.example                 # + INTEGRATION_OWNER_USER_ID, MCP_*, GITHUB_REPO, JIRA_*, NOTION_*, SLACK_*, DRIVE_*, GOOGLE_*, ACTIONS_* (all commented out)
apps/web/README.md           # + "Action tools (feature 010b)" section, routes, and the connection variables
```

**Structure Decision**: The existing monorepo. Server code goes in a new `src/actions/` beside `src/agents/`, `src/chat/`, and `src/cluster/`; routes under the existing `/api/workspaces/:id` tree; the shared UI in `apps/extension/src/ui/` (the folder 006 created for components Home and the sidebar both use). The safety-critical rules are each in one small file that can be reviewed and mutation-tested apart: `access.ts` (who may use what), `args.ts` (locking and limits), `loop.ts` (the allowlist), `confirm.ts` (the one-way send), and the mail-to-prompt type guard (`PrivateContent`, in `model.ts`).

## Changes outside this feature's own files (flag when doing them)

| Change | Why | Where |
| --- | --- | --- |
| `readEntries` reads only agent ids; `insertPendingRun` input is generic | Tool runs share `action_runs`; without the filter they push agent results out of the "60 newest" read | `src/agents/runs.ts` (behavior for agents unchanged; 010 tests protect it) |
| `MAX_RUNNING_PER_USER` 3 to 5 | Agents and tools share one small per-person cap (spec edge case) | `src/agents/limits.ts`, `tests/agents-limits.test.ts` |
| `executeRun`'s answer step extracted into `produceOutput()` | `write_summary` reuses 010's gather, safe read, one AI request, and validation instead of copying it | `src/agents/run.ts` |
| New AI purpose `suggest` (share 40); `command` share 60 to 20 | Automatic passes must not drain the `actions` share that clicks need; `command` (011) has not been built | `src/llm/budget.ts`, `openai-compat.ts`, `tests/llm.test.ts` (asserts the purpose list), `tests/llm-vt.test.ts`, `.env.example`. Sum of shares stays 400; cap stays 450. **Revisit `command` when 011 is planned.** |
| Saved summary, queries, and references join chat's and agents' data blocks | Spec FR-025 and User Story 4 scenario 4 ("chat can see those queries") | `src/chat/context.ts`, `src/agents/context.ts`, `src/agents/prompt.ts` (existing chat and agents tests protect the rest) |
| Home card: a suggested-actions group beside the agents | The feature's UI | `apps/extension/src/home/Home.tsx`, `home.css`; note against 005 FR-004/FR-006 |
| Sidebar still shows 010's stubs | Mounting `ActionsGroup` in the sidebar is the intended reuse but is **not part of this feature** (as 010) | Flag; no edit |
| Test schema setup | Apply the new migration in every test database | `tests/global-setup.ts` (its `SCHEMAS` list). `apply-sql.mjs` takes a file argument and needs no change. |
| `CLAUDE.md`: "don't start P1/stretch work before [the MVP cut line] ships" | This feature is stretch. The spec's Assumptions record that it starts early **at the requester's explicit request**; 010, which it depends on, is complete (62 of 62 tasks). | Flag only. No edit. |
| `FEATURES.md` (already modified on this branch) | Gmail added to 010b | Already changed before planning |

## Risks and how the plan handles them

- **Real MCP servers were not run against at planning time (largest schedule risk).** The reference servers for GitHub, Slack, and Drive are deprecated on npm; the maintained and hosted ones are mostly OAuth-first. Mitigation: bindings resolve against `tools/list` (unresolved means *unavailable*, never a crash), a read-only live probe per integration adjusts them, one probe task per integration is independent and parallel, and a REST connector can replace any one integration behind the same seam. MCP does not gate the demo (Constitution IV): the local tools work with none of it.
- **Automatic suggestions send workspace text to the AI service on every open** (accepted in the spec's Clarifications): tab titles, plain addresses, excerpts, the saved summary's first 1,200 characters, checklist, saved queries. Bounded by reuse (research 5) and a separate budget share. Mail is never included (type guard plus a sentinel test).
- **SC-016 deviation.** "Exactly 1 AI request per open" becomes "at most 1, exactly 1 unless the same unchanged workspace was asked in the last 5 minutes". Settable to 0 (`ACTIONS_SUGGEST_REUSE_S=0`) for literal behavior. **Needs the requester's decision.**
- **SC-005 exception.** The mail-search result is shown once and not kept. **Needs the requester's decision** (the alternative, storing it, breaks FR-036).
- **Prompt injection through tool output** (pages, issues, messages, mail). Defences stack: one JSON data block and fixed rules; the model can only return JSON; the server, not the model, chooses what runs; only five read-only helpers are callable and only one write, the button's own; locked prefill; addresses to open and email recipients are not model-composed at click time; targets are validated against this workspace's own runs; destinations are configuration; send needs a separate confirmation of a stored message. Tested with at least five hijack styles (SC-011) and mutation checks.
- **Composed external writes are not previewable** (research 6, item 6). Bounded by fixed destinations and immediate result links; the suggestion pass prefills whenever it can. Recorded, not hidden.
- **Google account access is the highest-consequence data.** Owner-only in one function (`access.ts`) that both the suggestion pass and every route call; a non-owner gets the same "not available" whether or not Google is connected; mail never stored, never in a prompt, never in a log.
- **Exfiltration through opened addresses.** Only prefilled, visible, `https`, public addresses (at most 5) open; searches are built by the server at a fixed host. The extension re-checks every address.
- **In-memory state on one server process** (suggestion cache, integration health, MCP sessions, Google token): a restart costs one new pass and one reconnect; "one at a time" for runs is still a database index. As 008 and 010, several processes are not supported.
- **PDF quality.** A text-only writer with Latin-1 output; other scripts become `?` and the run says so (spec: "a simple text document"). If real-language summaries need more, a font-embedding library is the follow-up, not part of this feature.
- **AI budget.** Suggestion passes, clicks, chat, clustering, and agents share the 450/day cap; a card-heavy session can spend it. `suggest` has its own share and the gap; messages say which limit was hit.
- **stdio servers run as child processes.** They get a minimal environment (their own credentials plus `PATH`), never the server's whole environment or the database URL; commands come only from configuration.
- **Dependency size and bundling.** The SDK pulls its own dependencies (including `zod`). Implementation checks the Next build (scratch copy) and adds `serverExternalPackages` if the bundler objects.

## Complexity Tracking

Constitution Governance: "Complexity beyond the MVP cut line MUST be justified against Principle VI." This feature is stretch, beyond the cut line (001 to 011).

| Deviation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| Work beyond the MVP cut line, started before the MVP ships | The requester explicitly asked for it on this branch (spec Assumptions). It is isolated: a sibling module, one table, four small listed seams in 010/008 code, one card group. With nothing configured it changes no visible behavior beyond three to six local buttons; removing the module leaves 010 intact. It does not gate the demo. | Waiting for the cut line contradicts the request; a stub-only interface (Constitution IV allows "stubbed") would not deliver the real actions the feature exists for. |
| A new npm dependency (`@modelcontextprotocol/sdk`) | The feature is an MCP client; a hand-written client would reimplement session, transport, and content negotiation. | A hand-written JSON-RPC client is more code and more risk than the reference SDK; REST-only adapters drop MCP (kept as the per-integration pivot). |
| A new table (`workspace_notes`) | The spec adds three new durable workspace facts (summary, queries, references) that chat and agents read and that need caps and dedupe. | Storing them in `action_runs.output` makes "the current summary" a history query and cannot enforce uniqueness or caps. |
| A JSON-step loop instead of native provider tool calling | One code path for both providers with no provider changes beyond one purpose; the allowlist stays in server code; fully scriptable tests. | Native tool calling needs the VT `-legacy-tool-calling` variants and Gemini's different function-calling shape: two new provider paths, limiter family, and budget accounting, for a loop of at most four turns. |
| A hand-written PDF writer (~90 lines) | "A simple text document" (spec) with no new dependency. | A PDF library still needs an embedded font for non-Latin text, so it does not remove the real limit and adds a dependency. |
| Two-phase email send | Spec FR-035 and SC-009 require the exact recipient, subject, and body to be confirmed. | Sending from the click with a client flag has no immutable text and can double-send. |
| Raising `MAX_RUNNING_PER_USER` from 3 to 5 and adding an AI purpose | Agents and tools share one per-person cap; automatic passes need their own budget share. | Keeping 3 makes a click fail while two agents run; sharing the `actions` budget lets idle cards starve clicks. |
