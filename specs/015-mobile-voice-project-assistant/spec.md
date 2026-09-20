# Feature Specification: Mobile Voice and Project Assistant

**Feature ID**: 015  
**Status**: Draft  
**Created**: 2026-09-20  
**Depends on**: 014 pairing and mobile chat, 008 workspace chat, 010b action tools; 011 is optional  
**Surfaces**: `apps/mobile` and the existing `apps/web` API

## Goal

A paired person can speak a question on the phone, review and edit its ElevenLabs transcript, and ask about one workspace or all of their projects. They can follow an answer with requests such as “make a Notion page for that” or “email me that.” The assistant resolves “that” to a visible answer or artifact, prepares a concrete action, and asks the person to review it before an external write. Typed input uses the same flow. The phone and desktop continue to share workspace data.

This extends the mobile web companion. “Project” means a persisted workspace; this feature does not introduce another project database.

## Current product boundary

- Mobile currently has pairing, a workspace directory, saved pages, and per-workspace text chat. It has no microphone, global chat, or action UI.
- Workspace chat reads one workspace and explicitly excludes other workspaces. Its existing API must retain that boundary.
- Feature 010b already defines a server-side tool registry, Notion page creation, Gmail draft and send, action runs, owner-only Google access, and a separate email confirmation route. This feature routes language to those guarded paths; it does not create an unrestricted MCP executor.
- Feature 014 describes voice as optional and mobile actions as later work. This feature makes speech-to-text and the selected action flow explicit and testable.

## User stories and acceptance

### 1. Ask by voice in a workspace (P1)

From a workspace conversation, the person taps a microphone, speaks a short question, and sees a transcript in the composer. They can edit or discard it. Sending it creates a normal user chat message and answer in the existing workspace history.

1. A committed transcript appears as editable text; partial text is visibly provisional and is never submitted by itself.
2. Sending a transcript uses the same authenticated workspace chat endpoint as typed input. A desktop reload shows the message and answer.
3. Silence, denial of microphone permission, unsupported capture, loss of connection, or STT failure leaves the typed composer usable and creates no message.
4. Recording visibly starts and stops by user action, has a short duration cap, and stops when the user navigates away or the paired device is revoked.

### 2. Ask across projects (P1)

From the mobile directory, the person can ask “What are my projects about?”, “Which project has the Kyoto research?”, or “What should I do next across my projects?” A distinct all-projects conversation answers from a bounded, user-scoped snapshot of workspace names, summaries, plans, recent saved results, and a small number of page titles and excerpts. Each factual claim links to the workspace or saved artifact that supports it. The person can open a cited workspace and continue there.

1. A paired user sees only their own workspaces, including saved workspaces with no open tabs. The unassigned “Other” bucket is labelled separately and is never represented as a project.
2. A reply distinguishes sourced findings, missing information, and inference. If the snapshot is truncated, it says so and offers a narrower workspace query.
3. A question about a particular workspace may navigate to its existing chat; all-projects history is stored separately and never injected into a workspace's chat history.
4. A request for data the product does not hold gets a clear limitation, not a fabricated answer.

### 3. Act on an answer by natural language (P1)

After an answer, the person can say or type “make a Notion page for that” or “email me that.” The UI displays what “that” refers to, the destination, and the content to be sent. The person can edit or cancel before approving. No external write occurs merely because the utterance was transcribed or interpreted.

1. The request creates a proposal tied to the exact answer or artifact ID and workspace context. If “that” is ambiguous, the assistant asks the person to select a source.
2. Notion creation shows the parent destination, title, and complete page body before a separate “Create page” tap. The result displays the returned page URL or a clear error.
3. “Email me that” creates a draft or preview addressed to the authenticated person's configured address. It never guesses an address from page content or a transcript. The person reviews recipient, subject, and full body and separately taps “Send email.” The existing Gmail confirmation path performs the send at most once.
4. If a connected service or permission is unavailable, the proposal offers a copyable version of the content and names the missing connection. It does not claim success.
5. Requests for other MCP tools may be added only through the existing allowlisted registry, schema validation, permission checks, and action-run audit trail. The assistant cannot install a server or call an arbitrary tool named in page text.

### 4. Continue across devices (P2)

A project answer, approved action, and resulting Notion link or email status can be found again from the phone. Workspace-bound actions appear in that workspace's existing action history on desktop. An all-projects answer retains its cited workspace IDs so later follow-ups and actions can resolve its source without relying on hidden model memory.

## Interaction model

1. The person chooses **All projects** or opens one workspace. Both views offer type and microphone controls.
2. The phone captures audio after permission and sends it to ElevenLabs STT. ElevenLabs returns provisional and committed transcript segments. Only committed text is assembled into the editable composer.
3. The person taps Send. The server classifies the text as a question or a request for a supported action. Classification can suggest a proposal but cannot execute a write.
4. Questions use the selected scope. Answers return text plus source references and a stable answer ID.
5. Action requests resolve a source answer/artifact, create a validated proposal, and show a review screen. Editing content requires server validation again before the action can run.
6. A separate approval tap calls the existing action path. Gmail sending keeps its second, exact-message confirmation step. Success is shown only after the action run reports success.

Voice input is an interface to text and action proposals. ElevenLabs is the transcription provider; it is not the reasoning model or MCP host. Tap-to-listen speech output can be added later without changing stored text or action semantics.

## Functional requirements

- **FR-001**: All voice, cross-project, proposal, and action endpoints MUST require a valid paired device token and scope every read and write to that token's person. Revocation MUST end access on the next request.
- **FR-002**: The phone MUST provide clear microphone start/stop/cancel controls, permission feedback, editable committed transcript, and a fully usable typed path.
- **FR-003**: An ElevenLabs API key MUST remain server-side. For live browser transcription, the server MAY issue an authenticated, short-lived single-use ElevenLabs token; it MUST NOT return the long-lived API key. The implementation MAY instead proxy a capped recording through the server to ElevenLabs batch STT. The chosen route must have request size, duration, and rate limits.
- **FR-004**: Audio MUST be sent only after microphone permission and an explicit start gesture. The app MUST NOT store raw audio in the product database. Transcript text is saved only when the person sends it as a message or approves an action; temporary draft text remains client-side.
- **FR-005**: Speech recognition MUST use committed, stable transcript events for the composer and handle reconnects, silence, duplicate commits, and cancellation without duplicate sends.
- **FR-006**: Workspace voice questions MUST use the existing `/api/workspaces/:id/chat` read and write semantics and preserve its one-workspace context boundary.
- **FR-007**: All-projects questions MUST have a separate authenticated API and conversation store. Its retrieval MUST query only the person's workspaces and use a documented, deterministic budget for workspaces, artifacts, tabs, history, and model context. It MUST report omitted coverage.
- **FR-008**: Cross-project answers MUST carry server-resolved source references (workspace ID, optional artifact or page ID) and never invent clickable references from model output alone. Source text, transcripts, and MCP output are untrusted data, never instructions.
- **FR-009**: A natural-language action request MUST resolve its referent to an answer/artifact ID and immutable content snapshot. If none or multiple plausible referents exist, it MUST ask for selection.
- **FR-010**: The server MUST expose only an allowlist of action intents backed by the 010b registry. It MUST validate argument schema, integration availability, user ownership, destination, content size, and output state again at execution time. No model response directly calls MCP.
- **FR-011**: An external write MUST require a separate approval after showing the full destination and payload. A Notion page requires explicit approval. Email requires preview/draft and the existing exact recipient/subject/body send confirmation. Repeated taps or retries MUST NOT create duplicate writes.
- **FR-012**: “Email me” MUST use a verified account address supplied by account configuration or an address the person explicitly enters and confirms. The current pairing model alone does not provide an email identity.
- **FR-013**: A multi-project answer used for an action MUST be snapshotted into one reviewable body with citations and provenance. If the existing workspace-scoped action API cannot represent that scope, the implementation MUST introduce a scoped aggregate artifact and guarded action adapter rather than attach the action to an arbitrary workspace.
- **FR-014**: The mobile UI MUST display pending, succeeded, failed, cancelled, and expired proposal/action states. It MUST not show a created page or sent email until the provider confirms success.
- **FR-015**: Missing ElevenLabs configuration MUST disable only voice capture. Missing MCP or Google credentials MUST disable only the affected action. Text questions remain available.
- **FR-016**: The server MUST cap audio time, transcription requests, cross-project model input and output, concurrent requests, proposal lifetime, and per-person action frequency. It MUST avoid logging audio, transcripts, answer bodies, page content, credentials, and email payloads.

## Proposed contracts and records

These are new contracts to refine during planning. Existing workspace chat and 010b action contracts remain authoritative for their respective operations.

| Contract | Purpose |
| --- | --- |
| `POST /api/voice/stt-token` **or** `POST /api/voice/transcribe` | Authenticated access to ElevenLabs STT; return only transcript events/text and bounded errors. |
| `GET /api/projects/chat` | Page through the paired person's all-projects conversation. |
| `POST /api/projects/chat` | Answer one all-projects question; return message IDs, answer text, citations, and coverage counts. |
| `POST /api/action-proposals` | Resolve a text request plus `sourceAnswerId` or `sourceArtifactId` into one reviewable, expiring proposal. Never execute. |
| `GET /api/action-proposals/:id` | Reopen a proposal with its exact source, destination, payload, and state. |
| `POST /api/action-proposals/:id/approve` | Revalidate and execute one approved Notion creation or Gmail draft path with an idempotency key; email send still uses the existing confirm route. |
| `POST /api/action-proposals/:id/cancel` | Mark a proposal cancelled without a service call. |

Records: `ProjectChatMessage` (person-scoped, role, text, citations, coverage, timestamp), `ActionProposal` (person, source scope and ID, immutable source snapshot, proposed tool and args, destination, state, expiry, idempotency key, resulting `ActionRun` ID), and existing `ActionRun`. Persist the minimum data needed for history and audit; retention and deletion policy must be specified in planning before migration.

## Retrieval and reference rules

- Use a two-stage query: first a compact index of all the person's workspaces (names, summary snippets, freshness, counts), then fetch details for the best matching workspaces within a fixed budget. Give an explicit “I checked N of M projects” indicator.
- Consider saved summaries, plan items, agent outputs, refs, tab titles and excerpts. Fetch public page text only through the existing safe page reader after an explicit request that needs it; never silently fetch arbitrary private or local URLs.
- Exclude another person's rows at the SQL layer. Do not send secrets, full URLs with query strings, email content, or unrelated action outputs to the model. Keep prompt injection defenses from 008/010b.
- Answer “what did I decide?” from stored conversation or artifacts only when those records are in the selected retrieval set; otherwise say that the evidence is missing.
- Citations are resolved by the server against retrieved rows. The model may select source IDs from supplied candidates but may not author arbitrary URLs.

## Failure and edge cases

- A transcript says “email me that” while a different project is open: show the chosen answer title, project/scope, and full email preview; never infer from hidden conversation alone.
- A cited tab, workspace, or source answer is deleted before approval: expire the proposal or require a fresh preview. An immutable source snapshot can still be offered for copy, with deletion clearly indicated.
- A service credential is removed after proposal creation: approval fails as unavailable without calling the service.
- The request names a nonexistent Notion parent, an unverified recipient, or a tool outside the allowlist: refuse that destination and keep the answer available.
- A timeout or retry during an external write: query or reconcile the saved action run before retry; never blindly issue another write.
- A very large number of projects: show coverage and support narrowing by project; do not silently drop projects while claiming a complete answer.

## Success criteria

- In a paired-phone walkthrough, a spoken workspace question becomes an editable transcript, is sent once, and appears in the same workspace history on desktop.
- Cross-project answers about a seeded set of projects cite only owned, real workspace/artifact records; a separate user's project is absent from retrieval and citations in automated tests.
- “Make a Notion page for that” creates exactly one page after review and approval; cancelling creates none. The resulting URL is visible on mobile and the corresponding workspace history where applicable.
- “Email me that” never sends before the exact recipient, subject, and body are reviewed and the second send confirmation is tapped; retrying does not send twice.
- With ElevenLabs or an integration unavailable, typed all-projects questions and existing workspace chat still work.

## Delivery slices

1. **Voice input**: authenticated ElevenLabs STT, editable transcript, existing workspace chat integration, capture and failure tests.
2. **All-projects knowledge**: separate read-only conversation, bounded retrieval, citations, coverage, user isolation tests.
3. **Natural-language actions**: referent resolution, proposal and review UI, Notion create and Gmail draft/send through the 010b guarded paths, idempotency and failure tests.
4. **Polish**: cross-device history, accessibility, mobile viewport walkthrough, latency and cost measurement, optional tap-to-listen output.

## Verification plan

- Unit and in-process API tests with fake ElevenLabs STT, model, Notion, and Gmail connectors; assert no write occurs during transcription, question answering, or proposal creation.
- Test multi-user isolation, revoked tokens, prompt injection in pages/transcripts, ambiguous “that,” missing connection, expired proposal, double approval, send retry, and truncation disclosure.
- Run mobile build, both app test suites, and `pnpm typecheck`; walk through microphone permission, denial, interrupted recording, action review, and result display on a phone-sized viewport.

## External references checked during specification

- [ElevenLabs client-side realtime STT](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/client-side-streaming): browser capture can use a server-issued single-use token.
- [ElevenLabs realtime STT API](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime): partial and committed transcript events.
- [ElevenLabs batch transcription API](https://elevenlabs.io/docs/api-reference/speech-to-text/convert): server-upload alternative for short recordings.
