# Implementation Plan: Workspace Agents

**Branch**: `010-workspace-agents` | **Date**: 2026-09-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/010-workspace-agents/spec.md`

## Summary

Give every workspace a fixed list of five one-shot **agents** (summarize, compare, what's missing, next steps, collect refs). Pressing one stores a `pending` run and returns at once; a background job reads a few public pages safely, makes **one** AI request over that workspace's own material, validates the answer, and saves the result, which appears under the agent on the expanded Home card and survives reloads. "Next steps" also rewrites the workspace's plan items, which chat already reads.

Server side (`apps/web`): four routes, a small `src/agents/` module (catalog, prompt, validation, run lifecycle, a purpose-built **safe page reader**), and a few small changes to the shared AI layer. Client side (`apps/extension`): the Home card's three columns become tabs | chat | agents. Design detail: [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), validation: [quickstart.md](./quickstart.md).

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22, Next.js 16 App Router (`apps/web`); React 19 in `apps/extension`. `apps/web/AGENTS.md` warns Next 16 differs from older versions: the route-handler docs (`route.md`) were read for 008; this feature adds only ordinary JSON handlers (`202`, `200`), and deliberately does **not** use `after()` (research 1).

**Primary Dependencies**: `@ai-browser/shared`, `pg`, the shared AI layer (`src/llm/`), and Node built-ins (`node:https`, `node:dns`, `node:net`, `node:zlib`). **No new runtime dependency**: the page reader and the HTML-to-text extractor are hand-written and table-tested (research 2 and 4).

**Storage**: Existing Postgres (Tiger). The existing `action_runs` and `plan_items` tables (feature 001) are used as they are. New idempotent migration `packages/shared/sql/010_agents.sql` adds **three indexes** (one is the "one running run" guard). No new table, no new column.

**Testing**: `tsc --noEmit`; Vitest on PGlite with an injected fake agent model and fake page fetcher (no network); table tests for the address rules; one real-socket test that a loopback listener is never connected to; HTML fixtures for extraction; extension unit tests for the pure client helpers; one opt-in live check (`AGENTS_LIVE=1`) against the active provider. Nothing touches Tiger by default.

**Target Platform**: A local Next.js server on a machine that can reach the AI provider (the VT VPN for the default provider) and the public internet (for page reading). Chrome extension pages call it.

**Project Type**: Web API in the existing app `apps/web` plus a UI change in `apps/extension`.

**Performance Goals**: 9 of 10 runs finish and show a result within 45 s (SC-001): page reading at most 12 s, the model at most 30 s, 50 s job limit as a backstop.

**Constraints**: Every query filters by `user_id` and the workspace id. One AI request per run, only when pressed. The server may connect **only** to addresses it has checked to be public, over `https` on port 443, and never sends cookies or credentials. Tab, page, result, plan item, and chat text is never logged. Reading limits are small and fixed (research 2).

**Scale/Scope**: About 8 pages, 40 tabs, and 20 chat messages of context per run; a person has at most 3 runs going; about 55 stored runs per workspace at most. Four routes, one migration of indexes, a shared types file, and one Home component.

## Constitution Check

*GATE: Must pass before Phase 0. Re-check after Phase 1.*

| Principle | Status | How this plan complies |
| --- | --- | --- |
| I. Workspace-First | PASS | The workspace owns its runs, results, and checklist (workspace-scoped rows that outlive tabs and the browser); it is the only context an agent may use. |
| II. Extension observes and presents; server decides | PASS | Context building, page reading, the model call, validation, and persistence are all on the server. The extension only calls the routes and draws the result. |
| III. User corrections win | PASS | Agents never move, group, or recategorize tabs. Ticking is the person's own edit, saved as they made it. |
| IV. Least-power actions | PASS | A **fixed catalog of one-shot tools**: one prompt, one AI request, one validated result. The page reader is a hard-coded tool, not an agent loop; no computer use, no MCP, no dynamic discovery. This is exactly the clarification added to Principle IV in v1.4.0. |
| V. One TypeScript surface | PASS | Response types live in `@ai-browser/shared` (`agents.ts`); `ActionRun` and `PlanItem` are reused. The agent list component imports nothing Home-specific so the sidebar can mount it (no forked UI). |
| VI. Demo-hard, architecture-soft | PASS | Uses the provider-neutral AI layer; failures show plain messages and never block the rest of the product. The MVP loop step "agents" (v1.4.0) is what this delivers. |
| VII. Two surfaces | PASS (staged) | The list is built on Home first, as agreed; the sidebar (006) reuses it. Home is not the only place a workspace is used once 006 lands, and nothing server-side is Home-only. |
| Stack / secrets | PASS | No new vendor; no key handling of its own. The page reader sends no credentials. Nothing sensitive is logged. |
| Persistence: user-scoped rows | PASS | `action_runs` and `plan_items` rows are user-scoped with a composite foreign key onto the workspace. |

**Gate result: PASS** (before Phase 0).

**Post-design re-check: PASS.** Phase 1 added one hand-written network component (the page reader). It does not conflict with a principle, but it is the feature's largest risk, so it is tracked below rather than hidden.

## Project Structure

### Documentation (this feature)

```text
specs/010-workspace-agents/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── http.md
│   ├── model.md
│   └── shared-agent-types.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks, not created here
```

### Source Code (repository root)

```text
packages/shared/
├── sql/010_agents.sql            # NEW: three indexes (idempotent)
└── src/
    ├── agents.ts                 # NEW: AgentId/Kind, AgentRunView, AgentResult, WorkspaceAgents, error codes
    └── index.ts                  # + export * from "./agents"

apps/web/
├── app/api/workspaces/[id]/
│   ├── agents/route.ts                          # NEW: GET catalog + latest + running + planItems
│   ├── agents/[agentId]/run/route.ts            # NEW: POST (202)
│   ├── agents/[agentId]/runs/route.ts           # NEW: GET history
│   └── plan-items/[itemId]/route.ts             # NEW: PATCH { done }
├── src/agents/                                  # NEW module
│   ├── catalog.ts        # the five agents: id, name, description, kind, task text, schema
│   ├── limits.ts         # every fixed limit and its env override (one file)
│   ├── errors.ts         # request errors (AgentRequestError) and the fixed run-failure sentences
│   ├── runs.ts           # DB: insert pending (unique guard, stale reap), finish, list, retention, per-person cap
│   ├── jobs.ts           # tracked background jobs on globalThis; idle() for tests
│   ├── context.ts        # gather tabs, plan items, recent chat (reuses chat/messages + chat/context fitHistory)
│   ├── prompt.ts         # fixed rules + the one JSON data block
│   ├── validate.ts       # per-kind answer checks; quote verification; tab id mapping
│   ├── model.ts          # AgentModel seam; getAgentModel(); setAgentModelForTests()
│   ├── run.ts            # the job: gather → read pages → ask once → validate → finish (one transaction)
│   ├── plan-items.ts     # list, rewrite (keep ticked, replace unticked), and tick
│   ├── guard.ts          # route guard: token, `other` bucket, workspace lookup (shared by the four routes)
│   └── pages/
│       ├── safe-address.ts   # URL rules, hostname rules, BlockList of non-public ranges
│       ├── fetch-page.ts     # node:https transport: checked lookup, manual redirects, caps, decompression cap
│       ├── extract.ts        # HTML to text
│       └── read-pages.ts     # the seam: pick, de-duplicate, limit, read 4 at a time, never throws
├── src/llm/
│   ├── types.ts              # + deadlineMs on GenerateJsonOptions
│   ├── openai-compat.ts      # honor deadlineMs; drop plan from the default-model table
│   ├── gemini.ts             # honor deadlineMs
│   ├── budget.ts             # Purpose loses "plan"; actions share 120
│   └── situation.ts          # NEW: describeFailure(error) shared by chat and agents
├── src/chat/errors.ts        # friendlyLlmError uses describeFailure (same sentences)
├── src/chat/context.ts       # export fitHistory
├── src/map.ts                # + DbActionRun, ACTION_RUN_COLUMNS, mapActionRun; DbPlanItem, mapPlanItem
└── tests/
    ├── agents.test.ts                # routes and lifecycle (fake model, fake reader)
    ├── agents-pages.test.ts          # address rules, transport, extraction, loopback refusal
    ├── agents-validate.test.ts       # answer validation and quote verification
    ├── agents-helpers.ts             # fake model, fake reader, seeding, run-and-wait
    ├── agents-live.test.ts           # opt-in AGENTS_LIVE=1
    ├── fixtures/agent-pages/*.html   # article, docs with nav, login shell, app shell, hostile text
    └── global-setup.ts               # also apply 010_agents.sql

apps/extension/
├── src/ui/                 # the folder Home and the sidebar (feature 006) already share (TabMark, TabRow)
│   ├── agents.ts           # NEW: client (list, run, runs, tick) + pure helpers (poll decision, view mapping)
│   ├── AgentsColumn.tsx    # NEW: the agents column; imports nothing Home-specific, so the sidebar can mount it
│   └── agents.css          # NEW: its styles, imported by the component so either surface gets them
├── src/home/
│   ├── Home.tsx            # remove ACTIONS stub and artifacts band; mount AgentsColumn
│   └── home.css            # three-column card; remove the now-unused stub styles
└── tests/ui-agents.test.ts

.env.example                 # + the AGENT_* variables; drop LLM_MODEL_PLAN
apps/web/README.md           # + "Agents (feature 010)" section and routes
```

**Structure Decision**: The existing monorepo. Server code goes in a new `src/agents/` beside `src/chat/` and `src/cluster/`; routes under the existing `/api/workspaces/:id` tree; the shared UI in `apps/extension/src/ui/` (the folder 006 created for components Home and the sidebar both use). The page reader is split into four small files so the safety rules (`safe-address.ts`, `fetch-page.ts`) can be reviewed and tested apart from extraction.

## Changes outside this feature's own files (flag when doing them)

| Change | Why | Where |
| --- | --- | --- |
| `plan` AI purpose removed; `actions` share 80 to 120 | The plan feature was cut; agents draw on `actions` | `src/llm/budget.ts`, `openai-compat.ts`, `tests/llm.test.ts`, `tests/llm-vt.test.ts`, `.env.example` |
| `deadlineMs` option on `generateJson` | Agents need 30 s; clustering keeps 25 s | `src/llm/types.ts`, both providers, `tests/llm*.test.ts` |
| `describeFailure` extracted from chat's error mapping | One classification for chat and agents | `src/chat/errors.ts` (behavior unchanged, existing chat tests protect it) |
| `fitHistory` exported | Agents cap chat the same way chat does | `src/chat/context.ts` |
| Home card layout changes | Replaces the 005 action and artifact stubs | `apps/extension/src/home/Home.tsx`, `home.css`; note against 005's spec FR-004/FR-006 |
| Sidebar still shows the old stubs | 006's `sidebar/ToolPlaceholders.tsx` has disabled "plan", "summarize / collect refs / new artifact", and chat placeholders. Mounting `AgentsColumn` there is the intended reuse but is **not part of this feature** (spec: the sidebar reuses the list later) | Flag to the person; no edit here |
| 008 spec Assumptions mention plan items arriving with "feature 009" | Stale after the cut | Left for the person to decide; not edited here |

## Risks and how the plan handles them

- **The page reader is the largest risk (server-side request forgery).** Mitigation: it checks the address the socket actually connects to, re-checks every redirect hop, refuses IP literals, odd ports, credentials, and internal hostnames, sends nothing personal, and is covered by table tests, a real-socket refusal test, and mutation checks (weaken a rule, confirm a test fails). It reads only what a person already has open, and only at plain addresses.
- **Untrusted page text reaching the model.** Same defence as 008 (one JSON block, fixed rules, no tools, plain-text rendering) plus quotes verified against the material; five injection styles in the live check (SC-008).
- **Quality on thin pages.** Sign-in pages, PDFs, and app-style pages will not read. The result says so plainly and the agent is told not to guess; this is by design (spec Assumptions).
- **Run time.** The model call can approach its 30 s limit with a large prompt. Sizes are capped (about 90,000 characters worst case) and `LLM_MODEL_ACTIONS` can select the faster `-thinking-low` variant if measured time demands; the live check records timing.
- **One server process.** The job registry and the per-process download slots are in memory; "one at a time" is a database index and survives several processes, but a job whose process died is only reaped after 120 s. Recorded, as in 008.
- **Budget interaction.** Chat, clustering, and agents share the 450/day cap; a busy chat day can leave agents with the spill-over pool only. The messages say which limit was hit.

## Complexity Tracking

No constitution violations to justify. The one place this feature adds more machinery than usual (a hand-written, safety-critical network reader) is recorded under Risks above, with the alternatives rejected in research 2 and 4.
