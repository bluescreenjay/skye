# Implementation Plan: Workspace AI Chat

**Branch**: `008-workspace-ai-chat` | **Date**: 2026-09-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/008-workspace-ai-chat/spec.md`

## Summary

Add the **server side** of per-workspace chat to `apps/web`: `POST /api/workspaces/:id/chat` sends a message and returns the assistant's reply (streamed as events once the model has produced its first words, or as one JSON body), and `GET /api/workspaces/:id/chat` reads the saved conversation. For each message the server builds a bounded context from that one workspace only (its tabs, its plan items, its recent messages), asks the active AI provider through a new **streaming call in the shared `src/llm/` layer**, and saves the user's message first and the assistant's message only after the reply finished, so a half-written reply can never exist as complete. Failures (unreachable, busy, over budget, VPN off, interrupted) keep the user's message, say plainly what happened, and can be retried without duplicates. No new table or column: the existing `messages` table is reused and gains one index. No UI: the sidebar chat panel (feature 006, built by someone else) calls these routes.

Design detail: [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), validation: [quickstart.md](./quickstart.md).

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22, Next.js 16 App Router (`apps/web`). `apps/web/AGENTS.md` warns Next 16 differs from older versions: read the route-handler docs (`route.md`, including how a handler returns a streamed `Response`) under `apps/web/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/` before writing the route.

**Primary Dependencies**: `@ai-browser/shared`, `pg`, the shared AI layer from feature 004 (`src/llm/`). **No new runtime dependency**: streaming uses `fetch` and web streams.

**Storage**: Existing Postgres (Tiger). The existing `messages` table (feature 001) is used as is. New idempotent migration `packages/shared/sql/008_chat.sql` adds one index. No new table, no new column, `001_init.sql` and `004_clustering.sql` are not edited.

**Testing**: `tsc --noEmit`; Vitest on PGlite with an injected fake chat model (no network); a fake `fetch` returning byte streams for the provider streaming code; one opt-in live check (`CHAT_LIVE=1`) against the active provider on an in-process database; the curl scenarios in [quickstart.md](./quickstart.md).

**Target Platform**: A local Next.js server on a machine that can reach the AI provider (for the default VT provider, on the VT VPN). Chrome clients call it in feature 006.

**Project Type**: Web API in the existing monorepo app `apps/web`.

**Performance Goals**: First words within 3 s and a full reply within 20 s for workspaces up to 20 tabs (SC-002). Measured 2026-09-19 on the default provider: `gpt-oss-120b-thinking-low` first words 0.3 s (9 and 20 tabs), full reply about 3 s; the medium model varied from 0.5 to 4.2 s with service load, which is why the low-effort model is the chat default (research section 9).

**Constraints**: Every query filters by `user_id` and the workspace id; nothing else is read for chat. A model request only when a user sends or retries a message, one logical request per message (attempts inside the AI layer to get it through are not extra requests). No retry after the first piece of a reply. The concurrency slot is held for the whole stream. Logs carry ids and counts only. One reply in flight per workspace. No new environment variables.

**Scale/Scope**: Up to 40 tabs and 20 messages of context per question; a handful of messages a minute per user. Two routes and one migration index.

## Constitution Check

*GATE: Must pass before Phase 0. Re-check after Phase 1.*

| Principle | Status | How this plan complies |
| --- | --- | --- |
| I. Workspace-First | PASS | The workspace owns its conversation; it is the context boundary; closing tabs or the browser does not delete it (messages are kept while the workspace exists). |
| II. Extension observes and presents; server decides | PASS | Context building, the model call, and persistence are all on the server. The extension only calls the two routes. |
| III. User corrections win | PASS | Not affected: chat has no tools and never changes tab placement (FR-014, FR-019). |
| IV. Least-power actions | PASS | One model request per message, no tools, no agent loop. |
| V. One TypeScript surface | PASS | New response shapes live in `@ai-browser/shared` (`chat.ts`); `Message` is reused unchanged. |
| VI. Demo-hard, architecture-soft | PASS | Streaming goes through the provider-neutral AI layer (VT default, Gemini backup); no new vendor; failures degrade to clear messages, never blocking the rest of the product. |
| VII. Two surfaces | PASS | Chat is served to the sidebar (feature 006); Home is not a second chat box. This feature builds neither screen. |
| Stack / secrets | PASS | No new vendor and no key handling of its own. Messages and page text are never logged. |
| Persistence: user-scoped rows | PASS | Messages are user-scoped with the existing composite foreign key onto the workspace. |

**Gate result: PASS** (before and after Phase 1 design).

## Project Structure

### Documentation (this feature)

```text
specs/008-workspace-ai-chat/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── http.md
│   ├── model.md
│   └── shared-chat-types.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks, not created here
```

### Source Code (repository root)

```text
packages/shared/
├── sql/008_chat.sql                        # NEW: one index on messages (idempotent)
└── src/
    ├── chat.ts                             # NEW: ChatContextInfo, ChatReply, ChatHistoryPage, ChatStreamEvent, ChatErrorCode
    └── index.ts                            # CHANGE: export chat

apps/web/
├── app/api/workspaces/[id]/chat/route.ts   # NEW: POST send (stream or JSON), GET history, OPTIONS
├── src/
│   ├── llm/                                # the shared AI layer from feature 004
│   │   ├── types.ts                        # CHANGE: ChatTurn, StreamTextOptions
│   │   ├── sse.ts                          # NEW: byte stream -> "data:" payloads (handles lines split across chunks)
│   │   ├── openai-compat.ts                # CHANGE: vtStreamText; chat default model -> gpt-oss-120b-thinking-low
│   │   ├── gemini.ts                       # CHANGE: geminiStreamText
│   │   └── index.ts                        # CHANGE: streamText (picks the provider, like generateJson)
│   └── chat/
│       ├── model.ts                        # NEW: ChatModel, getChatModel(), setChatModelForTests()
│       ├── context.ts                      # NEW: builds the system message, data block, and turns for one workspace
│       ├── messages.ts                     # NEW: insert a message, newest message, history page, recent turns
│       ├── lock.ts                         # NEW: one reply in flight per user+workspace, with a 120 s limit
│       ├── send.ts                         # NEW: validate, lock, save, build context, start the stream, finish or abandon
│       ├── errors.ts                       # NEW: ChatError (code, status, message) and the mapping from AI-layer errors to status, code, plain-language message
│       └── events.ts                       # NEW: encode the meta/delta/done/error events
└── tests/
    ├── chat-helpers.ts                     # NEW: fake chat model (scripted, failing, gated, abort-aware), seeding
    ├── llm-stream.test.ts                  # NEW: both providers' streaming with a fake fetch, split chunks, no retry after start, slot held, abort
    ├── chat-context.test.ts                # NEW: caps, ordering, stripping, JSON escaping of hostile text, isolation, history trimming
    ├── chat.test.ts                        # NEW: send/stream/JSON, persistence, follow-ups, isolation, injection input, failures, retry, lock, validation, history paging, no calls without a send, logs
    ├── chat-live.test.ts                   # NEW: opt-in (CHAT_LIVE=1), real provider, four question types + injection tabs
    └── fixtures/chat-questions.json        # NEW: the four question types with the tab topics each answer must mention
```

**Structure Decision**: Everything stays in `apps/web` and `packages/shared`; no new package, no extension change. Streaming is added to the **shared** AI layer (not the chat folder) so features 009 to 011 reuse it and every model call keeps going through the provider choice, the budget, and the limiter. Chat-specific logic (context, persistence, lock, orchestration) is in `src/chat/`, separate from the route so it is testable without HTTP.

## Cross-feature changes (flagged)

All additive; no existing response changes.

| Where | Change | Why |
| --- | --- | --- |
| `apps/web/src/llm/` (feature 004's layer) | Add `streamText`, its types, the SSE line reader, and the two provider stream implementations | Chat needs streaming, and it must share the budget, limiter, and provider choice |
| `apps/web/src/llm/openai-compat.ts` | `DEFAULT_MODELS.chat` changes from `gpt-oss-120b` to `gpt-oss-120b-thinking-low`; the test asserting the defaults is updated | Measured first-words latency (research section 9); `LLM_MODEL_CHAT` still overrides |
| `packages/shared/src/index.ts` | export `chat.ts` | shared response shapes |
| Database | one new index on `messages`; applied with `apply-sql.mjs` (a write to the shared Tiger database, so it is an explicit quickstart step) | history and "newest message" reads |
| Feature 006 (another person's work) | none in code; this plan gives them the HTTP contract and the client rules (text rendering, no remote images, `replying`, Retry) | the sidebar consumes these routes |

## Complexity Tracking

| Deviation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| The reply lock is in memory, not in the database | One local server process is the deployment (the VT endpoint is unreachable from a hosted server); a lock with a 120 s limit cannot get stuck | A database lock row is a migration and a query per message for a case (several server processes) that does not exist yet; revisit if the app is hosted |
| The response head is delayed until the first model piece | Lets every pre-stream failure be a normal HTTP status with a JSON body | An always-streaming response forces every client to parse an event stream to learn of a 404 or a busy service |
| Streaming code in the shared layer rather than beside chat | Features 009 to 011 stream too, and the budget, limiter, and provider choice must wrap every call | A chat-only streaming helper would need those guards copied and would drift |

## Risks

- **Prompt injection can never be fully excluded.** Measured 0 of 5 hijacked on both candidate models, and the design limits the damage: no tools, only this workspace in the context, untrusted text only inside an escaped data block. The remaining risk is a client that renders a reply's remote images or links; the contract tells feature 006's authors not to.
- **Latency varies with the shared VT service** (medium effort took 0.5 to 4.2 s to first words in probes). Mitigation: low-effort default; `LLM_MODEL_CHAT` and `LLM_PROVIDER=gemini` as switches.
- **The VPN dropping mid-reply** ends the reply as interrupted with nothing saved for it; the user retries. A VPN that is off before sending is a clear message with the question saved.
- **An in-memory reply lock** would not protect several server processes (see Complexity Tracking).
- **Text streamed before a failure is not kept.** Accepted: it keeps "no partial reply as complete" trivially true.
- **Sensitive pages**: page text goes to the AI service (URLs lose query strings first). Same known limit as features 002 and 004; the VT service also retains interactions.
- **The default provider needs the VT VPN and a personal VT key** (feature 004's research section 19); a teammate needs their own key or Gemini.

## Next

`/speckit-tasks`, then `/speckit-analyze`, then `/speckit-implement`.
