---
description: "Task list for 008 Workspace AI Chat"
---

# Tasks: Workspace AI Chat

**Input**: Design documents from `/specs/008-workspace-ai-chat/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/http.md, contracts/model.md, contracts/shared-chat-types.md, quickstart.md

**Tests**: Included, as the plan specifies: Vitest integration tests on PGlite with an injected fake chat model, a fake `fetch` for provider streaming, and one opt-in live check. They never touch Tiger and never call a real provider by default. Drop the test tasks (T008, T016, T017, T022, T025, T028, T032, T038, T039) if you want none; nothing else depends on them except that the fake-model helper (T014) is used by them.

**Organization**: Grouped by user story from spec.md (US1 to US5). US1 to US4 are P1 and US5 (streaming delivery) is P2. The model call itself is always a stream inside the code; US1 to US4 are exercised in JSON mode (`stream: false`) and US5 adds the event-stream delivery, so the server is usable and testable before streaming reaches the HTTP layer.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1 to US5, only inside story phases
- Paths are from the repository root.

**Rules for the implementer**
- Before writing the route handler, read `apps/web/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` (including how a handler returns a streamed `Response`) and the route-segment-config docs (`apps/web/AGENTS.md`: this Next.js version differs from older ones). Existing routes show the pattern: `params` is a `Promise`, every handler starts with `requireUser`, responses use `src/json.ts`.
- Every model request goes through `apps/web/src/llm/` (provider choice, daily budget, concurrency limiter). Never call a vendor from chat code.
- Every SQL statement is parameterized and filters by `user_id` **and** the workspace id. In an `INSERT ... SELECT` or `SELECT` list, cast bare parameters (`$1::uuid`): Postgres cannot infer their type there.
- Never log message text, tab titles, addresses, excerpts, prompts, or model output. Log ids and counts only. Never put any of them in an error body either.
- Check real exit codes: run typecheck and tests without piping them through `tail` (a pipe hides the failing exit status).
- Vitest hides `console.log` output of passing tests; for live checks pass `--disable-console-intercept`.
- Never run anything against the Tiger database except where a task says it needs the user's approval (T043, T044). Do not commit; do not edit `spec.md`, `plan.md`, or `data-model.md`; if reality contradicts them, stop and say so.

---

## Phase 1: Setup

**Purpose**: The two shared pieces every other task needs.

- [x] T001 [P] Create `packages/shared/sql/008_chat.sql`: a header comment (requires 001 first, safe to re-run, adds no table or column) and `CREATE INDEX IF NOT EXISTS messages_user_workspace_created_idx ON messages (user_id, workspace_id, created_at DESC, id DESC);`. Do not edit `001_init.sql`.
- [x] T002 [P] Create `packages/shared/src/chat.ts` with `ChatContextInfo`, `ChatReply`, `ChatHistoryPage`, `ChatStreamEvent`, and `ChatErrorCode` exactly as in `contracts/shared-chat-types.md`, and add `export * from "./chat";` to `packages/shared/src/index.ts`. Do not change `Message`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Streaming in the shared AI layer, the message mapper and database helpers, typed chat errors, the chat model seam, and the test plumbing. MUST complete before any story.

**⚠️ CRITICAL**: No story work can begin until this phase is complete.

- [x] T003 [P] In `apps/web/src/llm/types.ts` add `ChatTurn` (`{ role: "user" | "assistant"; content: string }`), `StreamTextOptions` (`purpose`, `system`, `messages`, optional `maxTokens`, `signal`, and the test-only `fetchImpl` and `sleep`, per `contracts/model.md`), and constants `STREAM_TOTAL_MS = 90_000` and `DEFAULT_CHAT_MAX_TOKENS = 1500`. Do not change anything existing.
- [x] T004 [P] Create `apps/web/src/llm/sse.ts`: `readDataLines(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string>` that decodes UTF-8 incrementally and yields the payload of each `data:` line (text after `data:` with one optional leading space removed). It must cope with a line split across network chunks, `\r\n` and `\n`, blank lines, comment lines (`:`), `event:` lines (ignored), and a multi-byte character split across chunks. It stops when the stream ends or the signal aborts, and always cancels the reader in a `finally`.
- [x] T005 In `apps/web/src/llm/openai-compat.ts` add `vtStreamText(options: StreamTextOptions): AsyncGenerator<string>` and change `DEFAULT_MODELS.chat` to `gpt-oss-120b-thinking-low`. Behavior (contracts/model.md, research sections 1 and 2): key check first (`ModelUnconfiguredError`); model from `vtModelFor(options.purpose)`; request body `{ model, stream: true, temperature: 0.3, max_tokens: options.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS, messages: [{ role: "system", content: system }, ...messages] }`. **Before the first piece** reuse the same handling as `vtGenerateJson` (extract the status classification into a shared helper rather than copying it): `spend` per attempt, a slot from `acquire(model, signal)`, retry of the 400 "concurrent session limit reached" and of 429 with backoff, one retry of 502/503/504, the VPN/401/403/404 messages, all inside the 25 s first-byte deadline. On HTTP 200 read the body with `readDataLines`, parse each payload as JSON, yield `choices[0].delta.content` when it is a non-empty string, ignore `reasoning_content` and `reasoning`, stop at `[DONE]`. **After the first piece there is no retry**: a broken connection or unreadable payload throws `ModelError`. Hold the concurrency slot until the generator finishes, throws, or is stopped (`finally`), and abort the fetch on `return()` or when `signal` aborts. Enforce `STREAM_TOTAL_MS` for the whole stream. A stream that ends with no text at all throws `ModelError("The AI service returned an empty answer.")`. Generic messages only; nothing here logs. (depends on T003, T004)
- [x] T006 [P] In `apps/web/src/llm/gemini.ts` add `geminiStreamText(options: StreamTextOptions): AsyncGenerator<string>`: `POST {ENDPOINT}/{model}:streamGenerateContent?alt=sse`, header `x-goog-api-key`, body `{ systemInstruction: { parts: [{ text: system }] }, contents: <turns with role "model" for assistant>, generationConfig: { temperature: 0.3, maxOutputTokens, thinkingConfig: { thinkingLevel: thinkingLevel() } } }`. Same rules as T005 where they apply: `spend` per attempt, 429 is never retried (`BudgetExceededError`), one retry of 503 before the first piece, 404 names the model, generic messages, no retry after the first piece, `STREAM_TOTAL_MS`, abort on `return()`, empty answer is a `ModelError`. Read `candidates[0].content.parts[].text` skipping `thought` parts via `readDataLines`. (depends on T003, T004)
- [x] T007 In `apps/web/src/llm/index.ts` add `streamText(options: StreamTextOptions)` that returns `vtStreamText` or `geminiStreamText` according to `activeProvider()` (like `generateJson`), and re-export `ChatTurn` and `StreamTextOptions`. (depends on T005, T006)
- [x] T008 [P] Create `apps/web/tests/llm-stream.test.ts` and update `apps/web/tests/llm-vt.test.ts` (its `DEFAULT_MODELS` expectation: `chat` is now `gpt-oss-120b-thinking-low`, `actions` stays `gpt-oss-120b`). New tests, using a fake `fetch` that returns `Response` objects with a `ReadableStream` body built from strings split at awkward places: SSE reader (line split across chunks, `\r\n`, blank and comment lines, multi-byte character split, `[DONE]`); VT stream yields pieces in order, ignores `reasoning_content`, sends `stream: true` with the system message first and the turns after, and uses the chat model id; Gemini stream sends `systemInstruction` and `model`-role turns and skips `thought` parts; a busy 400 before the first piece is retried and then streams; **no retry** after a piece was yielded (a broken stream throws and `fetch` was called once); a 429 on the VT provider before the first piece is retried while on Gemini it is `BudgetExceededError` without retry; every attempt is counted by the budget; the concurrency slot is held while streaming (`limiterState()` shows it) and released after the end, after an error, and after `return()`; aborting the signal mid-stream stops it and frees the slot; an empty answer is a `ModelError`; the VPN 403 message; error messages never contain the server body; the total cap ends a hung stream (use a small injected cap or fake timers). (depends on T007)
- [x] T009 [P] In `apps/web/src/map.ts` add `DbMessage`, a `MESSAGE_COLUMNS` constant (`id, user_id, workspace_id, role, content, created_at`), and `mapMessage(row): Message` (timestamps to ISO strings).
- [x] T010 [P] Create `apps/web/src/chat/errors.ts`: a `ChatError` class carrying `status`, `code` (a `ChatErrorCode` from `@ai-browser/shared`), and a fixed user-facing `message`, with constructors for `invalid_message` (400), `message_too_long` (400, carries `limit: 4000`), `not_a_workspace` (400), `reply_in_progress` (409), `nothing_to_retry` (409); and `friendlyLlmError(error)` mapping the shared errors to `{ status, code, message }` per research section 11: `BudgetExceededError` → 429 `budget_exhausted` (busy versus daily versus vendor quota wording taken from the error's own generic message), `ModelError` → 502 `model_error` (VPN message passed through), `ModelUnconfiguredError` → 503 `model_unconfigured` ("The AI assistant isn't set up on this server yet."). Every message except `model_unconfigured` ends with "Your message is saved." (or the retry hint). Messages never include prompts, tab content, message text, or vendor bodies. (depends on T002)
- [x] T011 Create `apps/web/src/chat/model.ts`: `ChatModel` (`stream(input: { system: string; messages: ChatTurn[] }, signal?: AbortSignal): AsyncIterable<string>`), `getChatModel()` (the override if set, else a model whose `stream` calls `streamText({ purpose: "chat", ... })`; throws `ModelUnconfiguredError(unconfiguredMessage())` when `providerConfigured()` is false, so a caller can fail before writing anything), and the test seam `setChatModelForTests(model | null)`. (depends on T007)
- [x] T012 Create `apps/web/src/chat/messages.ts` with the database helpers, all filtering by `user_id` and workspace id and using `MESSAGE_COLUMNS`/`mapMessage`: `findWorkspace(userId, id)` (returns the workspace row or `null`; a non-UUID `id` returns `null` without querying, which avoids Postgres error 22P02); `insertMessage(userId, workspaceId, role, content)`; `newestMessage(userId, workspaceId)`; `historyPage(userId, workspaceId, { limit, beforeId })` returning `{ messages (oldest first), hasMore }` ordered by `(created_at, id)` with a message-id cursor (a `beforeId` that is not a message of this workspace returns `null` so the route can answer `400 invalid_cursor`); `recentTurns(userId, workspaceId, limit)` returning the last N `user` and `assistant` messages oldest first. (depends on T009)
- [x] T013 In `apps/web/tests/global-setup.ts` also apply `packages/shared/sql/008_chat.sql` to PGlite after 001 and 004, and keep blanking every provider key unless `CLUSTER_LIVE` or `CHAT_LIVE` is `1`. (depends on T001)
- [x] T014 Create `apps/web/tests/chat-helpers.ts`: `fakeChatModel(script)` returning a `ChatModel` that records each call's `system` and `messages` and follows a script (pieces to yield, an optional delay between pieces, an error to throw **before** the first piece, an error to throw **after** N pieces, or a gate to hold it open); a `gate()` helper (a promise the test releases); an `installFakeChatModel` wrapper using `setChatModelForTests` (cleared afterwards, and calling the budget's and limiter's `resetForTests`); an `abort`-aware `stream` that stops promptly when its signal aborts and records that it was stopped; and small wrappers to create a workspace, put tabs into it through the real tab-ref route (with title, address, and snippet), add plan items directly with SQL, and call the chat route handler with a token (JSON mode) and read an event stream body into a list of events. Reuse `tests/helpers.ts` (`req`, `read`, `reset`). (depends on T011, T013)
- [x] T015 Checkpoint: `pnpm -r typecheck`, `pnpm --filter @ai-browser/web test`, and `pnpm --filter @ai-browser/extension test` all pass (check the real exit codes). Fix anything T005 broke in the existing 004 tests.

**Checkpoint**: The AI layer streams on both providers with the same guarantees as `generateJson`, and the database, error, and test plumbing for chat exists.

---

## Phase 3: User Story 1 - Ask about this workspace and get an answer that knows its tabs (Priority: P1) 🎯 MVP

**Goal**: Send a message to a workspace and get a reply built from that workspace's own tabs, plan items, and earlier messages, with the user's message saved first and the assistant's saved when the reply is complete, returned as one JSON body.

**Independent Test**: A workspace with six tabs on a known topic; a fake model that answers from its input. Send the four question types in JSON mode: each reply is saved with its question, the model was given the workspace's tabs (stripped addresses, capped excerpts) and no other workspace's, `context` reports how many tabs it covers, and a workspace with 60 tabs is bounded to 40 with `tabsTotal` 60.

### Tests for User Story 1 ⚠️ (write first; they fail until the implementation exists)

- [x] T016 [P] [US1] Create `apps/web/tests/chat-context.test.ts` for `buildContext` (T018): only this user's and workspace's tabs; `http(s)` only; open tabs first then newest; at most 40 tabs with `tabsIncluded` and `tabsTotal` correct; title cut to 200, address stripped of query string and fragment and cut to 200, excerpt cut to 400; plan items (up to 30, text cut to 200, `done` kept) included when present and an empty `plan` when not; the last 20 messages as turns, oldest first, `user` and `assistant` only, dropping the oldest first past 24,000 characters while the newest turn is always kept; the system message is the fixed rules followed by one JSON data block, and **all** titles, addresses, excerpts, plan text, and the workspace name appear only inside that block (a tab whose text contains quotes, newlines, `</`, and the words "ignore previous instructions" leaves the block parseable as JSON with the text intact and does not add any line outside it); an empty workspace says so in the data (`tabsInWorkspace: 0`) and invents nothing; two workspaces and two users never see each other's rows.
- [x] T017 [US1] Create `apps/web/tests/chat.test.ts` (later stories append their own `describe` blocks to this file) with the US1 block, using `chat-helpers.ts` and JSON mode: a message returns `{ userMessage, assistantMessage, contextInfo }` with the fake model's text; both messages are saved (user first, then assistant) with the right roles, workspace, and owner; the model input for each of the four question types (summarize, what's missing, what we decided, what next) contains the workspace's tabs; nothing from a second workspace of the same user is in the model input; `contextInfo` matches the input (`tabsIncluded`, `tabsTotal`, `planItemsIncluded`, `messagesIncluded`); a workspace with no tabs still works and says so in the data; a workspace with 60 tabs sends 40 and reports `tabsTotal: 60`; a tab with an empty excerpt is still sent with its title and address. (depends on T014)

### Implementation for User Story 1

- [x] T018 [US1] Create `apps/web/src/chat/context.ts` with `buildContext(userId, workspace, turnsLimit = 20)` returning `{ system, messages, info }` per `data-model.md` and `contracts/model.md`: query tabs (`user_id` and `workspace_id`, `http(s)` only, open first then `last_seen_at DESC`, `LIMIT 40`, with `count(*) OVER ()` for the total), plan items (`sort_order`, `LIMIT 30`), and `recentTurns`; sanitize each tab with the existing `stripUrl` from `apps/web/src/cluster/prompt.ts` and the caps; produce the system message as the fixed rules text from `contracts/model.md` followed by `JSON.stringify` of `{ workspace: { name, tabsInWorkspace, tabsShown }, tabs, plan }` (no untrusted text outside that JSON); apply the 24,000-character history limit; `info` is a `ChatContextInfo`. Log nothing. (depends on T012)
- [x] T019 [US1] Create `apps/web/src/chat/send.ts` with `beginReply(userId, workspaceId, options: { message?: string; retry?: boolean; signal?: AbortSignal })` returning a handle `{ userMessage, info, first: string, rest: AsyncGenerator<string>, complete(text): Promise<Message>, abandon(): void }`, in this order: find the workspace (`ChatError` not found handled by the route); check `getChatModel()` first so a missing key writes nothing; save the user message; build the context (its turns end with the new user message); start `model.stream({ system, messages }, signal)` and **await the first piece** (an error here propagates and the user message stays saved); return the handle. `complete(text)` inserts the assistant message once and returns it; `abandon()` stops the stream and inserts nothing. In this story also export `collectReply(handle)` that drains the stream into one string, calls `complete`, and returns `{ userMessage, assistantMessage, context }`. Log only ids and counts (message id, tab count, character count), never text. (depends on T018)
- [x] T020 [US1] Create `apps/web/app/api/workspaces/[id]/chat/route.ts`: `export const runtime = "nodejs"`, `export const maxDuration = 120` (above the 90 s stream cap), `OPTIONS`, and `POST` in JSON mode (**an omitted `stream` field means JSON until T036 makes streaming the default; every US1 to US4 test sends `stream: false` explicitly, so T036 must not break them**): `requireUser`, parse the JSON body, call `beginReply` then `collectReply`, return `200` with the `ChatReply`. Errors for this story: an unexpected failure is `500 { error: "Chat failed" }` with only the error class name logged. (Other statuses and the stream mode come in later stories.) (depends on T019)
- [x] T021 [US1] Checkpoint: `pnpm -r typecheck` and `pnpm --filter @ai-browser/web test`; fix failures until T016 and T017 pass and earlier suites still pass.

**Checkpoint**: A workspace can be asked a question and the reply is grounded in its own tabs, saved, and returned as JSON. This is the MVP.

---

## Phase 4: User Story 2 - The conversation is remembered per workspace (Priority: P1)

**Goal**: Read a workspace's saved conversation later, in order and in pages; follow-up questions use earlier messages.

**Independent Test**: Send three messages, read the conversation (six messages, oldest first, with times), read it again from a fresh request, ask a follow-up that only makes sense given the first exchange (the model input contains the earlier turns), and confirm a second workspace's conversation is untouched.

### Tests for User Story 2 ⚠️

- [x] T022 [US2] Append a US2 `describe` block to `apps/web/tests/chat.test.ts`: after three exchanges `GET` returns six messages, oldest first, alternating roles, with `createdAt` in order; a second read returns identical data (persistence does not depend on the earlier request); a follow-up's model input includes the earlier user and assistant turns in order, followed by the new question; a second workspace's conversation stays empty and a message in one workspace never appears in the other's history; a 30-message conversation is fully readable through pages: `limit` and `before` walk back through it with no gaps or duplicates, `hasMore` is true until the oldest page, and the default page is the newest one; the model still receives only the last 20 turns while the full history stays readable; `GET` makes no model call (the fake's call count does not change); `unansweredMessageId` is `null` after a completed exchange and `replying` is `false`; a `before` id from another workspace or an unknown id is `400 invalid_cursor`; `limit` above 200 is clamped and below 1 defaults to 50. (depends on T021)

### Implementation for User Story 2

- [x] T023 [US2] In `apps/web/app/api/workspaces/[id]/chat/route.ts` add `GET`: `requireUser`, `findWorkspace`, `limit` (default 50, clamp to 1 to 200) and `before`, call `historyPage`, and return a `ChatHistoryPage` `{ messages, hasMore, replying: false, unansweredMessageId }` where `unansweredMessageId` is the id of the newest message when its role is `user` and otherwise `null`; `400 invalid_cursor` when `historyPage` reports a bad cursor. (`replying` becomes live in US5.) No model call, no lock. (depends on T022)
- [x] T024 [US2] Checkpoint: `pnpm -r typecheck` and `pnpm --filter @ai-browser/web test`; fix failures until T022 passes and earlier stories still pass.

**Checkpoint**: Stories 1 and 2 work: grounded answers that are remembered and readable.

---

## Phase 5: User Story 3 - Each workspace is its own boundary (Priority: P1)

**Goal**: Nothing crosses a workspace or user boundary; page text is content, never instructions; the Other bucket is refused.

**Independent Test**: Two users with two workspaces each, distinctive tabs and messages, and a hostile tab: nothing from another workspace or user is in any model input or response or history; the hostile text is only inside the escaped data block; `other` is refused; another user's workspace id is `404`.

### Tests for User Story 3 ⚠️

- [x] T025 [US3] Append a US3 `describe` block to `apps/web/tests/chat.test.ts`: user A chats in workspace 1 and 2 with distinctive tab titles, excerpts, plan items, and messages; **no** model input or response for workspace 1 contains any distinctive string from workspace 2 or from user B, checked by searching the whole `system` and `messages` the fake received; user B (another token) gets `404` for send and read on A's workspace id and a workspace id A never created; a workspace id that is not a UUID is `404` without a server error; the literal id `other` is `400 not_a_workspace` for both send and read, with a friendly message; a missing or unknown token is `401` on both methods; a tab whose excerpt and title contain instructions, fake closing tags, and a request to reveal other workspaces appears in the model input only inside the JSON data block and the fixed rules text is unchanged, and the request still saves normally; archived workspaces can still be chatted with and read. (depends on T024)

### Implementation for User Story 3

- [x] T026 [US3] In `apps/web/app/api/workspaces/[id]/chat/route.ts` (both methods): answer `400 not_a_workspace` (via `ChatError`) when the path id is the literal `other`; use `findWorkspace` so an unknown, foreign, or non-UUID id is `404 { error: "Workspace not found" }` before anything else runs; keep `requireUser` first so unauthenticated calls are `401`. Confirm by reading the code that no query in `chat/context.ts` or `chat/messages.ts` can return a row without both the user id and the workspace id in its `WHERE` clause. (depends on T025)
- [x] T027 [US3] Checkpoint: `pnpm -r typecheck` and `pnpm --filter @ai-browser/web test`; fix failures until T025 passes and earlier stories still pass.

**Checkpoint**: Stories 1 to 3 work: grounded, remembered, and strictly bounded.

---

## Phase 6: User Story 4 - When the AI cannot answer, nothing is lost (Priority: P1)

**Goal**: Every failure keeps the user's message, says plainly what happened, saves no assistant message, and a retry answers the same message without duplicating it. Bad input is rejected without saving.

**Independent Test**: Make the fake model fail in each way and check the response, the saved messages, and a retry.

### Tests for User Story 4 ⚠️

- [x] T028 [US4] Append a US4 `describe` block to `apps/web/tests/chat.test.ts`: for each of `ModelError` (unreachable), `ModelError` with the VPN message, `BudgetExceededError` (busy), `BudgetExceededError` (daily allowance), thrown by the fake **before its first piece**: the status and `code` match `contracts/http.md` (`502 model_error`, `429 budget_exhausted`), the body has a plain-language `error` ending with the saved reassurance and the saved `userMessage`, exactly one user message is stored, **no** assistant message is stored, and the reply lock (US5) is not left held (a following send works); no vendor text, prompt, message text, or tab content appears in any error body; a missing key (no fake installed, keys blank in tests) is `503 model_unconfigured` and **nothing is saved**; validation: an empty, whitespace-only, non-string, or missing `message`, both `message` and `retry`, and a body that is not a JSON object are `400 invalid_message`, and a 4,001-character message is `400 message_too_long` with `limit` 4000, none of them saved; exactly 4,000 characters is accepted; a message is trimmed before saving; `retry: true` after a failure answers the saved message, creates **no** second user message, and the conversation then reads user, assistant; `retry: true` when the newest message is an assistant message or the conversation is empty is `409 nothing_to_retry`; sending a new message while an earlier one is unanswered is allowed and both user messages reach the model as consecutive turns; after a failed send, `GET` reports `unansweredMessageId` for the newest user message. (depends on T027)

### Implementation for User Story 4

- [x] T029 [US4] In `apps/web/src/chat/send.ts`: validate the input before anything is written (`invalid_message`, `message_too_long`, `message` xor `retry`) and trim the message; implement `retry` by using the newest message when its role is `user` (no insert) and throwing `nothing_to_retry` otherwise; verify the order built in T019 still holds (a missing key writes nothing; every later failure leaves the saved user message); on any error after the user message was saved, attach the saved `Message` to the thrown error so the route can return it. (depends on T028)
- [x] T030 [US4] In `apps/web/app/api/workspaces/[id]/chat/route.ts` (POST): catch `ChatError` and the shared AI errors, map them through `friendlyLlmError`/`ChatError` to `{ error, code, userMessage? }` with the statuses in `contracts/http.md`, and never include the underlying error text. Unexpected errors stay `500` and log only the class name. (depends on T029)
- [x] T031 [US4] Checkpoint: `pnpm -r typecheck` and `pnpm --filter @ai-browser/web test`; fix failures until T028 passes and earlier stories still pass.

**Checkpoint**: Stories 1 to 4 (all P1) work: grounded, remembered, bounded, and safe when the AI is not.

---

## Phase 7: User Story 5 - The reply appears as it is written (Priority: P2)

**Goal**: The reply is delivered as an event stream once the model produced its first words; one reply at a time per workspace; a cut-off reply is never saved.

**Independent Test**: With a fake model that yields pieces with delays: the first event reaches the caller before the model finished, the events are `meta`, `delta`s, `done`, the saved reply equals the concatenated deltas, an error after the first piece is an `error` event with nothing saved, a client disconnect saves nothing, and a second send during a reply is `409`.

### Tests for User Story 5 ⚠️

- [x] T032 [US5] Append a US5 `describe` block to `apps/web/tests/chat.test.ts`: the default (no `stream` field) response is `200 text/event-stream` with the headers in `contracts/http.md`; events arrive in the order `meta` (saved user message and `contextInfo`), one or more `delta`, exactly one `done`; the concatenated deltas equal `done.assistantMessage.content` and the saved row; the first event is readable **before** the fake model has produced its last piece (hold the fake open with a gate after the first piece); a failure before the first piece is a normal JSON error response (not a stream) with the user message saved; a failure **after** N pieces produces an `error` event as the last event, nothing is saved for the reply, the user message is saved and unanswered, and the workspace accepts a new message straight away; aborting the request signal mid-stream stops the fake (it records that it was stopped), saves no assistant message, and frees the workspace; `stream: false` still returns one JSON body; a second send to the same workspace while a reply is in flight (gate held) is `409 reply_in_progress` and saves nothing, `GET` shows `replying: true` meanwhile and `false` afterwards; a different workspace of the same user is not blocked; a lock older than 120 s is treated as stale (use an injectable clock or a test-only way to age it); two rapid sends never interleave. (depends on T031)

### Implementation for User Story 5

- [x] T033 [P] [US5] Create `apps/web/src/chat/lock.ts`: `tryLock(userId, workspaceId, now = Date.now())` returning a release function (safe to call twice) or `null` when a fresh lock is held; the map lives on `globalThis` (like the budget and limiter); a lock older than 120 s is replaced; `isLocked(userId, workspaceId)` for `GET`; `resetLocksForTests()`.
- [x] T034 [P] [US5] Create `apps/web/src/chat/events.ts`: `encodeEvent(event: ChatStreamEvent): string` producing `event: <name>\ndata: <JSON>\n\n`, and the constant headers (`content-type: text/event-stream; charset=utf-8`, `cache-control: no-cache, no-transform`, `x-accel-buffering: no`) merged with the CORS headers from `src/json.ts`.
- [x] T035 [US5] In `apps/web/src/chat/send.ts` take the reply lock right after validation and before the user message is saved (`ChatError` `reply_in_progress` when held), and release it in `complete`, `abandon`, and on every error path after it was taken; a lock must never outlive the handle. (depends on T033)
- [x] T036 [US5] In `apps/web/app/api/workspaces/[id]/chat/route.ts` (POST) implement the default stream mode: after `beginReply` returns (the first piece is already in hand), respond `200` with a `ReadableStream` body: enqueue `meta`, then the first `delta`, then each later `delta` as it arrives; on normal end call `complete` and enqueue `done`; on a failure after the first piece call `abandon` and enqueue `error` with code `interrupted` and the friendly message (any failure after the first piece is `interrupted`) then close; on client disconnect (`request.signal` aborts, or the stream is cancelled) call `abandon` and stop pulling. `stream: false` keeps the JSON path. In `GET` set `replying` from `isLocked`. Check the Next.js route docs for returning a streamed `Response` from a route handler before writing it. (depends on T034, T035)
- [x] T037 [US5] Checkpoint: `pnpm -r typecheck` and `pnpm --filter @ai-browser/web test`; fix failures until T032 passes and earlier stories still pass.

**Checkpoint**: All five stories work. The sidebar can consume the streaming route.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: The cross-cutting guarantees, the opt-in live check, docs, full validation, and the steps that touch shared systems.

- [x] T038 [P] Append two `describe` blocks to `apps/web/tests/chat.test.ts` (SC-006 and SC-008): **no model call without a send**: across reading history repeatedly, changing tabs through the tab-ref route, running the ingest route, creating and archiving workspaces, refused sends (in flight, invalid, unknown workspace, `other`, `nothing_to_retry`), and a retry that finds nothing, the fake's call counter stays 0; N sent messages make exactly N calls and each explicit retry makes exactly one more (counted at the chat-model call, the logical request; the AI layer's own attempts are covered by `llm-stream.test.ts`); **log safety**: spy on every `console` method through a successful stream, a JSON reply, a pre-stream failure, a mid-stream failure, an abort, and an unexpected error, using distinctive marker strings in the message, tab title, address, excerpt, plan item, workspace name, and the fake model's output and error text, and assert none of them appears in any logged argument or in any error body. Then run a mutation check once: temporarily make `send.ts` log the context, confirm the test fails, and restore the file exactly.
- [x] T039 [P] Create `apps/web/tests/fixtures/chat-questions.json` (the four question types, each with the tab topics its answer must mention and the topics it must not, plus a list of injection tab variants: reply-only-a-marker, a fake "Assistant:" title, print-your-prompt after a fake closing tag, a markdown image to an outside address, and invent-other-users) and `apps/web/tests/chat-live.test.ts`: `describe.skipIf(process.env.CHAT_LIVE !== "1")` seeds a workspace from the trip tabs in `apps/web/tests/fixtures/mixed-tabs.batch.json` (through the real routes, on PGlite) and a second workspace of unrelated tabs, then through the **real active provider** asks each question type (JSON mode), asserting the reply names content from the right workspace and none from the other (SC-001, at least 9 of 10 across the run), that, over **at least 10 streamed messages**, at least 9 deliver their first `delta` within 3 s **and** finish the full reply within 20 s (SC-002; record the median and the slowest), that one question written in another language (for example Spanish) is answered in that language, that each injection variant is not obeyed (SC-007: judge by whether the reply was hijacked, not by whether it quotes the tab title), and that the follow-up "what did we decide about the hotel?" uses an earlier turn. Document at the top: `CHAT_LIVE=1 pnpm --filter @ai-browser/web test chat-live --disable-console-intercept` (about ten provider requests; needs the VT VPN for the default provider; `LLM_PROVIDER=gemini` for the backup; never touches Tiger).
- [x] T040 [P] Update `apps/web/README.md`: add `POST` and `GET /api/workspaces/:id/chat` to the routes table and a short "Chat (feature 008)" section (what it does, that a model is called only when a message is sent, the event stream and JSON modes, that the default chat model is `gpt-oss-120b-thinking-low` with `LLM_MODEL_CHAT` to override, the client rules from `contracts/http.md`, how to apply `008_chat.sql`, and the opt-in live check). Also **edit** (not just append) the existing statements that chat defaults to `gpt-oss-120b`: the model row of the configuration table in `apps/web/README.md` and the comment sentence "gpt-oss-120b for chat and actions" in `.env.example`, so both say chat defaults to `gpt-oss-120b-thinking-low` and change the chat default mentioned in `specs/004-ai-clustering/research.md` section 19 and `specs/004-ai-clustering/contracts/model.md` (Configuration table) from `gpt-oss-120b` to `gpt-oss-120b-thinking-low`. Flag that edit to the user as a cross-feature doc change.
- [x] T041 Full validation (check real exit codes): `pnpm -r typecheck`; `pnpm --filter @ai-browser/web test`; `pnpm --filter @ai-browser/extension test` (244 tests unchanged); `pnpm --filter @ai-browser/web build` (proves the new route compiles and is registered as dynamic); `git status` shows no `.env`, `dist/`, or `.next/` files; a scan of every changed and untracked file for provider keys and database credentials finds nothing. (depends on T037, T038, T040)
- [x] T042 Run the opt-in live check once on the default provider and once on the backup (`CHAT_LIVE=1 pnpm exec vitest run tests/chat-live.test.ts --disable-console-intercept` from `apps/web`, then with `LLM_PROVIDER=gemini`); record the SC-001 score and the time to first words in the final report. Pace the requests (the Gemini free tier allows 15 per minute). It runs on an in-process database and does not write to Tiger. If a provider is unreachable (VPN off), say so instead of skipping silently. (depends on T039, T041)
- [x] T043 (manual, **needs the user's explicit approval**: writes to the shared Tiger database) Run `node apps/web/scripts/apply-sql.mjs packages/shared/sql/008_chat.sql`, then confirm with a read-only check that the index `messages_user_workspace_created_idx` exists and no other object changed. (depends on T041)
- [x] T044 (manual, needs the user; calls the provider and writes test rows to Tiger) Run `specs/008-workspace-ai-chat/quickstart.md` scenarios V1 to V9 against a real server and the real database with fresh `e2e-chat-…` tokens. Next.js 16 refuses a second `next dev` in the same folder, so if a dev server is already running, build once and run `next start` on another port with the environment each scenario needs (a spent budget: `LLM_DAILY_CAP=1`; no key: blank key; the VPN scenario is manual). Record the results and list the test rows left behind so the user can decide on cleanup. (depends on T043)
- [x] T045 Only after T041 to T044 pass (T042, the real-provider check, is a required gate for this row even though it is opt-in in code): set the 008 row in `FEATURES.md` to `☑ implemented (server side: the chat API; the sidebar chat panel is part of 006)`. (depends on T042, T044)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none; T001 and T002 in parallel.
- **Foundational (Phase 2)**: after Setup; blocks every story. Order: T003, T004, T009, T010 (needs T002) in parallel → T005 and T006 in parallel (each needs T003 and T004) → T007 → T008 and T011; T012 after T009; T013 after T001; T014 after T011 and T013; T015 last.
- **US1 to US5** each build on `context.ts`, `send.ts`, and the route from earlier phases, so run them in priority order (US1 → US2 → US3 → US4 → US5). They are independently *testable* (each Independent Test passes with only the stories before it), not independently parallelizable, because they edit the same files.
- **Polish (Phase 8)**: after US5; T043 to T045 are manual and in order.

### Within Each Story

- Test tasks first; they fail until the implementation lands.
- `context.ts` → `send.ts` → route.

### Parallel Opportunities

- Phase 1: T001, T002.
- Phase 2: T003, T004, T009, T010 together; then T005 with T006; T008 with T011 and T012.
- US1: T016 can be written while T018 is being implemented (different files).
- US5: T033 and T034.
- Polish: T038, T039, T040.

### Parallel Example: Phase 2 start

```bash
Task: "Add ChatTurn, StreamTextOptions and the stream constants in apps/web/src/llm/types.ts"   # T003
Task: "Create apps/web/src/llm/sse.ts (data: line reader)"                                       # T004
Task: "Add DbMessage and mapMessage to apps/web/src/map.ts"                                      # T009
Task: "Create apps/web/src/chat/errors.ts (ChatError and friendlyLlmError)"                      # T010
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup, then Phase 2 Foundational (stop at its checkpoint, T015).
2. Phase 3 (US1). **Stop and validate**: a workspace answers the four question types in JSON mode from its own tabs, and both messages are saved.
3. That is a working chat server, though not yet safe or streamed.

### Incremental Delivery

1. Foundation → US1 (grounded answers).
2. US2 adds the readable, remembered conversation.
3. US3 makes it strictly bounded (the trust story). Do not hand this to the sidebar without it.
4. US4 makes failures safe (the AI service will fail; the VPN will drop). Together US1 to US4 are the P1 scope.
5. US5 adds streaming delivery. Do it before the sidebar integrates, since that is the experience people will judge.
6. Polish, then the manual database and live checks.

### Notes

- Do not apply the migration to Tiger, or run the live quickstart, until T043 and T044 are approved.
- Do not commit; tasks are checked off as they complete.
- If reality contradicts `plan.md`, `spec.md`, or `data-model.md` (for example a provider streams differently than research recorded), stop and say so rather than editing them.
- The lesson from feature 004's live check: run against the real provider early. A model can behave differently from the fake (a schema change once made Gemini drop a whole group), so T042 is not optional in spirit even though it is opt-in in code.
