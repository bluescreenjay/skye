# Research: AI Clustering

Decisions that turn the spec into a buildable design. Nothing here is a `NEEDS CLARIFICATION`; each item records what was chosen, why, and what was rejected.

## 1. How the model is called

- **Decision**: One adapter, `ClusterModel.propose(input)`, with a Gemini implementation that calls the Gemini REST `generateContent` method through `fetch` (API key in the `x-goog-api-key` header, model id from `GEMINI_MODEL`). No SDK dependency.
- **Where it lives**: the vendor call is in the shared `apps/web/src/llm/gemini.ts` (with `errors.ts` and `budget.ts`), not under `cluster/`, because features 008–011 make model calls too (see §18). `cluster/model.ts` is the thin, clustering-specific layer on top.
- **Rationale**: The constitution wants vendor calls behind a small adapter so a pivot is "config plus one module". REST through `fetch` adds no dependency, is trivial to fake in tests, and keeps the timeout under our control (`AbortSignal.timeout`).
- **Alternatives considered**: `@google/genai` SDK (more surface, another dependency to track across pivots); calling the model from the extension (violates principle II and would ship the key); a second provider implemented now (Pivot rule says swap only if Gemini fails).
- **Verified live on 2026-09-19** with the project's key, using 8 invented tabs (no real user data):
  - `GET /v1beta/models` lists `gemini-2.5-flash`, **but calling it returns 404 "no longer available to new users"**. Do not use it. A model appearing in the list does not mean it is callable.
  - `gemini-3.6-flash` works. Request shape that returned clean JSON: `generationConfig` with `responseMimeType: "application/json"` and a `responseSchema` (OpenAPI-style uppercase types, `nullable: true` for optional strings). The answer arrives as JSON text in `candidates[0].content.parts[0].text`.
  - `gemini-3.5-flash-lite` works with the identical request: about 1.2–1.3 s for 8 tabs, clean JSON, correct groups (two clear groups; the two unrelated tabs left out), and when given a listed existing workspace that fit one group it returned that workspace's id in `existingWorkspaceId` (the reuse behavior User Story 3 depends on). `thinkingConfig: { thinkingLevel: "minimal" }` is accepted; **`thinkingBudget: 0` is rejected with HTTP 400** on this model, so use `thinkingLevel`.
  - On `gemini-3.6-flash`, latency for 8 tabs was about 4 s with default thinking and about 1 s with thinking minimized; grouping was equally sensible in all runs.
  - Untested: 50–100 tabs, and actual quota headroom (the API does not report it). SC-006 (30 s for 50 tabs) is checked by quickstart V9.
- **Default model**: `gemini-3.5-flash-lite`, pinned, overridable with `GEMINI_MODEL`. Chosen at the user's request to avoid rate limits: lite models normally have higher request quotas than the full flash models. Trade-off: a lite model may group less cleverly on genuinely ambiguous tabs; that is what the confidence bar and suggestions absorb, and the live fixture score (SC-001) is the check. If quality falls short, switch `GEMINI_MODEL` to `gemini-3.6-flash` (verified) with no code change. Not the `gemini-flash-latest` alias: it worked, but an alias silently changes behavior under a confidence bar we tune against a fixed model. Model ids at Google are retired quickly (2.5 already is), so the adapter treats a 404 from the model as `ModelError` with a message that names the id, so the fix (change `GEMINI_MODEL`) is obvious.
- **Rate limits**: the adapter already retries once on HTTP 429/503 (research §16); a persistent 429 becomes `502 model_error` with nothing changed. Runs are on request and skipped when nothing changed (§8), so call volume stays low.
- **Thinking**: send `thinkingConfig: { thinkingLevel: "minimal" }` to keep runs fast. If the live score (SC-001) comes in under 80%, raise it before touching prompts.
- Because the response is always validated by our own code (item 4), a mismatch in the schema hint degrades to a failed run, never to bad data.

## 2. What is sent to the model

- **Decision**: For each candidate tab send a short local id (`t1`, `t2`, ...), the title (max 200 chars), the URL **without query string or fragment** (max 200 chars), and the snippet cut to 600 chars. Send the active workspaces as `{ id, name }` so the model can reuse them. Nothing else: no user id, no device token, no timestamps.
- **Rationale**: FR-018 (send only what clustering needs). Query strings and fragments routinely carry tokens and personal data and add no grouping signal. Short ids keep the model from mangling UUIDs and cut tokens; we map them back and drop any id we did not send.
- **Alternatives considered**: send the stored 2000-char snippet (5x the tokens for little gain); send full URLs (privacy cost, no benefit); send UUIDs (invented or truncated ids).
- **Logging**: log counts, ids of the run, status, and latency only. Never log titles, URLs, snippets, prompts, or model output.

## 3. Which tabs are candidates

- **Decision**: Tabs of the requesting user with `workspace_id IS NULL` **and** `placement_source IS NULL`, an `http(s)` URL, ordered open tabs first (`chrome_tab_id IS NOT NULL`) then most recently seen, capped at 100 (`MAX_TABS_PER_RUN`). The rest stay in Other and are reported as `leftOut`.
- **Rationale**: Spec assumption (only Other tabs are candidates) plus FR-006 (a tab the user deliberately left in Other has `placement_source = 'user'` and is excluded). Preferring open tabs matches "a messy set of open tabs" while still clustering recently closed ones so a run is never empty just because the browser was restarted.
- **Alternatives considered**: only currently open tabs (empty after every restart until the extension re-snapshots); re-evaluating tabs already in workspaces (that is feature 007 territory and risks fighting the user).
- **Known gap**: a tab a user manually moved to Other **before** this feature shipped has no recorded origin, so it is treated as unplaced. There is no way to recover that intent, and it only affects old data.

## 4. Structured output and validation

- **Decision**: Ask for JSON with `responseMimeType: "application/json"` and a response schema, then validate the parsed value with a hand-written validator (the repo's style, see `parseBatch`). Expected shape: `{ groups: [{ name, emoji, confidence, existingWorkspaceId | null, tabIds[] }] }`. Tabs not mentioned stay in Other.
- **Validation rules** (each violation discards only the offending item, not the answer): unknown or duplicate tab ids are dropped; `existingWorkspaceId` must be one we sent, else treated as null; confidence must be a finite number in 0..1; a group left with fewer than 2 tabs is discarded; a tab claimed by two groups goes to the higher-confidence one; names are trimmed, and a blank, over-80-character, reserved (`Other`) or generic (`Group 3`, `Untitled`, `Cluster`, `Miscellaneous`) name discards the group.
- **Rationale**: FR-005, FR-008, and the edge cases for unusable answers. A schema hint alone is not trusted.
- **Alternatives considered**: a validation library like zod (a new dependency for one shape); free-form text plus regex (brittle).

## 5. What "confidence" means

- **Decision**: The model reports one confidence per group (0..1). A group is auto-applied when `confidence >= CLUSTER_CONFIDENCE_BAR` (default `0.7`, env-tunable); otherwise it becomes a suggestion. The bar is one number per run.
- **Rationale**: Matches the spec assumption. Self-reported confidence is not calibrated, so the bar is deliberately conservative and the acceptance test set (SC-001, SC-004) is what tunes it.
- **Alternatives considered**: per-tab confidence (more output tokens, more edge cases); categorical high/medium/low (coarser, no easier to tune); a second "judge" model call (doubles cost and latency).
- **Chosen bar: 0.7** (user decision, 2026-09-19; the model stays `gemini-3.5-flash-lite`). Evidence: on the 30-tab fixture the lite model found the coding group only with a reworded prompt, and reported it at **0.70**; a stronger model (`gemini-3.6-flash`) reported 0.85. At the original 0.75 that group was only a suggestion and the live SC-001 score was 65%; at 0.7 the live fixture passes (at least 80%, and a 50-tab run under 30 s). The bar is one env value, and every applied group can be undone, so the cost of being slightly too eager is a click.

## 6. Existing workspaces and duplicates

- **Decision**: The prompt lists active workspaces and tells the model to reuse one when tabs clearly belong to it. On the server, a group with a valid `existingWorkspaceId` targets that workspace; a group with a new name that case-insensitively matches an active workspace name also targets that workspace. Archived workspaces are never sent and never targeted.
- **Rationale**: FR-006, FR-007, User Story 3.
- **Alternatives considered**: always create and merge later (violates "no near-duplicates", and merging is a 007 feature).

## 7. Suggestions: repeat and dismissal behavior

- **Decision**: Before the confidence check, every proposed group is compared with the user's stored suggestions by the overlap of their tab sets (Jaccard similarity of tab-ref ids, threshold `>= 0.7`):
  - overlap with an **ignored** suggestion: the group is dropped at **any** confidence. A dismissed idea is neither re-offered nor auto-applied unless its tabs materially change (overlap falls below 0.7);
  - overlap with a **pending** suggestion: if the group is still below the bar, refresh that suggestion in place; if it is now at or above the bar, apply the group and mark the old suggestion `withdrawn` (superseded);
  - no overlap: at or above the bar, apply it; below the bar, create a new suggestion.

  Pending suggestions are also withdrawn lazily when fewer than two of their tabs are still unplaced.
- **Rationale**: FR-004, User Story 2 ("ignoring stops it coming back"), SC-005 (no duplicates), Principle III. The first draft only suppressed *below-bar* look-alikes, so a group the user dismissed at confidence 0.6 could auto-apply when the model reports 0.8 on the next run (/speckit-analyze finding U1). Overlap is cheap and needs no model call. 0.7 means a group can gain or lose about a quarter of its tabs before it counts as "materially changed".
- **Alternatives considered**: exact tab-set equality (any added tab re-offers a dismissed idea); matching by name (the model renames the same group between runs); suppressing only below-bar groups (see rationale).

## 8. Skipping a run when nothing changed

- **Decision**: Compute a fingerprint (SHA-256) over the candidate tabs (id, url, title, hash of the snippet) and the active workspaces (id, name). Each finished run stores `settled_fingerprint`, computed **after** its changes were applied. A new run first computes the current fingerprint; if it equals the latest succeeded-or-undone run's `settled_fingerprint` and `force` is not set, return `skipped` without calling the model.
- **Rationale**: FR-014 and SC-005. Comparing with the state *before* the run would never match once tabs were moved out of Other; comparing with the settled state does.
- **After an undo**: the run's `settled_fingerprint` is recomputed from the reverted state. So an immediate non-forced re-run is skipped and does not silently redo what the user just undid. Once a new or changed tab arrives, the whole unplaced set (including previously undone tabs) is analyzed again. Remembering undone groups is learning-from-corrections, which the spec puts out of scope; the undo is recorded (run status `undone`) so a later feature can use it.
- **Alternatives considered**: a time-based cooldown (unrelated to whether anything changed); marking undone tabs as user-placed (locks them out of clustering forever, which the user did not ask for).

## 9. One run at a time

- **Decision**: A partial unique index allows only one `cluster_runs` row per user with `status = 'running'`. Starting a run inserts that row first; a unique violation is `409 run_in_progress`. A `running` row older than 120 seconds is treated as crashed and marked `failed` before a new run starts.
- **Rationale**: FR-014. No DB transaction is held open across the model call (which can take many seconds), and a crashed process cannot lock a user out.
- **Alternatives considered**: Postgres advisory locks (tied to one connection in a pool, awkward across a slow HTTP call); an in-memory mutex (breaks with more than one server process).

## 10. Applying results safely (user wins races)

- **Decision**: The apply step runs in one transaction after the model returns, one savepoint per group. Each tab moves with a conditional update: `SET workspace_id = $to, placement_source = 'ai' WHERE id = $id AND user_id = $user AND workspace_id IS NULL AND placement_source IS NULL`. A tab that changed in the meantime simply does not update. If a group ends with fewer than two moved tabs, its savepoint is rolled back (so no orphan workspace is created). Every moved tab gets a `cluster_run_moves` row.
- **Rationale**: FR-012, FR-009, SC-003.
- **Alternatives considered**: row locks held while the model runs (long locks on user data); re-reading and comparing in application code (a race window).

## 11. Undo

- **Decision**: `POST /api/cluster/runs/:id/undo` reverts only tabs that are **still where the run put them and still `ai`-placed** (`workspace_id = to AND placement_source = 'ai'`), setting them back to `workspace_id NULL, placement_source NULL`. It then archives each workspace the run created that now has no tabs and whose `updated_at = created_at` (untouched since creation). A tab the user moved keeps the user's placement; a workspace the user renamed or added to stays. Undoing an already undone run succeeds and reports zero reverted.
- **Rationale**: FR-010, User Story 4. Because only unplaced tabs are ever moved by a run, "prior placement" is always Other-unplaced, so no prior state has to be stored.
- **Note**: if a later feature lets AI move tabs out of existing workspaces, the moves table needs `from_workspace_id` and `from_placement_source`.
- **Alternatives considered**: deleting created workspaces (they may hold user-added work and other tables reference them); undoing only the latest run (a stale run would then be stuck).

## 12. Recording corrections and history

- **Decision**: (a) A user move of an `ai`-placed tab (through the existing `PATCH`/`PUT` tab-ref routes) writes a row to the existing `corrections` table. (b) An ignored suggestion and an undone run are themselves the durable signals: they keep their rows with status `ignored` / `undone` and a timestamp. (c) Every AI apply, suggestion accept, and undo append a `reassigned` event per moved tab to `tab_events`, so activity history reflects membership changes.
- **Rationale**: FR-011 needs the signals recorded, not used. Reusing `corrections` for tab moves avoids a new table; dismissals and undos do not fit its from/to shape, and their own rows already carry the fact.
- **Alternatives considered**: a new `signals` table (a second store for facts we already keep); using `corrections` rows with null from/to for dismissals (ambiguous meaning).

## 13. Who owns "placement source"

- **Decision**: Add nullable `tab_refs.placement_source` (`'ai'` or `'user'`; `NULL` = never placed). Any placement written by the existing 003 routes (`PATCH /api/tab-refs/:id`, `PUT /api/tab-refs` with `workspaceId` present) sets it to `'user'`. Accepting a suggestion also sets `'user'` (the user confirmed it). Ingestion (002) never touches it. The migration backfills `'user'` for every tab already in a workspace, since before this feature every assignment was manual.
- **Rationale**: Spec assumption and FR-009: the origin is durable per tab and drives what later runs may touch. `NULL` vs `'user'` is what separates "never organized" from "the user deliberately left this in Other".
- **Alternatives considered**: a separate table of placements (a join on every read); a boolean `ai_placed` (cannot express "user kept it in Other").

## 14. Reading results for Home and the sidebar

- **Decision**: Add `placementSource` to the shared `TabRef`, so `GET /api/resolve` and `GET /api/tab-refs` already tell the sidebar whether a tab was AI-placed. Add one read route, `GET /api/overview`, returning active workspaces with their tabs, Other, and pending suggestions in a single call for Home.
- **Rationale**: SC-009 (one round trip each). The route is data only; Home's screens are feature 005.
- **Alternatives considered**: Home stitching several calls together (breaks the one-round-trip criterion and duplicates the join logic in the client).

## 15. Applying the schema without psql

- **Decision**: New idempotent file `packages/shared/sql/004_clustering.sql` (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, guarded backfill). Provide `apps/web/scripts/apply-sql.mjs <file>` that runs a SQL file against `DATABASE_URL` using the existing `pg` dependency and the repo-root `.env` loader. Tests apply 001 then 004 to PGlite.
- **Rationale**: `psql` is not installed on the development machine (the 003 quickstart's `psql -f` does not work there). Running a migration against the real Tiger database changes shared state, so it is a separate, explicit step in the quickstart.
- **Alternatives considered**: auto-migrate on server start (surprising writes to a shared database, and 001's file is not re-runnable); a migration framework (out of proportion).

## 16. Failure behavior

- **Decision**:
  - No `GEMINI_API_KEY`: `503 model_unconfigured`, no run recorded.
  - Daily AI-call budget spent (our own meter, §18) **or** an HTTP 429 from Google: `BudgetExceededError` → `429 budget_exhausted`. A 429 is **never retried** (a per-minute limit lasts a minute and a per-day limit lasts a day, so a retry cannot help and only spends another request). The run row is stored `failed` with a generic message.
  - One **total** 25 s deadline covers the model call and its retry. HTTP 503 is retried once after about 1 s, only if the deadline allows. A timeout, other HTTP errors, a network error, or an answer that is not valid JSON of the expected top-level shape: run stored `failed` with a generic message (never page text); response `502 model_error` with the `runId`.
  - A well-formed answer is a **success** even when it has no groups, or when validation discarded every group: the run records nothing found and how many groups were discarded.
  - In every failure case no tab or workspace changed.
- **Rationale**: FR-013, SC-007, the Pivot rule (a dead provider must not break the manual workflow from 003), and the shared quota (§18).
- **Alternatives considered**: a keyword-based fallback clusterer (a second source of truth, which the constitution forbids); retrying 429s with backoff (wastes the scarce daily quota).

## 17. Testing approach

- **Decision**: Vitest against PGlite (the existing 003/002 setup) with an **injected fake `ClusterModel`** that can also be held open by a test-controlled gate (needed for the overlapping-run and stale-run tests); no test calls Gemini. Cover apply/suggest/undo/race/idempotence/isolation/fingerprint and the budget meter. One opt-in live check (`CLUSTER_LIVE=1`, needs a real key, still runs on PGlite) scores the 30-tab reference fixture against Gemini and also times a 50-tab batch. It is not part of the default `pnpm test`.
- **Fixtures**: the 30-tab set has an answer key and a small deliberately **ambiguous** group (work-or-leisure tabs) that the key does not score. A 50-tab batch covers SC-006. Fixture batches carry `events: []` because `tab_events` ids are unique across users, so replaying the same event ids under a second token would be silently deduplicated.
- **One scorer**: `apps/web/scripts/score-lib.mjs` holds the SC-001 scoring function; the live test and the CLI script both import it so the two cannot drift.
- **Live model confidence is high.** In the 2026-09-19 probes every group came back at 0.90–0.95, so with a bar near 0.7 the suggestion path may rarely trigger live. The quickstart forces it by setting `CLUSTER_CONFIDENCE_BAR=0.97`; automated tests cover the path with a fake model at chosen confidences.
- **Rationale**: Constitution quality bar: integration checks of the core loop over unit-test theater. Model quality is measured by the live fixture, not asserted in CI.

## 18. AI call budget (applies to every AI feature: 004, 008, 009, 010, 011, 012)

**Situation** (as stated by the user, 2026-09-19): the free Gemini quota for the chosen model is about 500 requests per day (not readable through the API; check AI Studio's usage page), there is no billing, and one key is shared by the developer, a teammate, and demo viewers.

- **Rules every AI feature follows**
  1. Only user-initiated calls. Nothing calls the model from a tab event, a tab switch, a timer, or a page load. Sidebar suggestions (012) reuse what 004 already stored.
  2. One model request per user action. No agent loops and no separate planner and writer calls. Where the model must call a tool (010), send one request, take the function call from the answer, and let the server execute it without a second request to feed the result back.
  3. Fold related output into one answer: a chat message that asks for a plan returns the reply and the plan items in one request (008/009).
  4. Cache by content: results that depend only on a workspace's state (summary, plan draft, comparison) are keyed by a fingerprint of that state and served from storage until it changes or the user asks to refresh (the same idea as §8).
  5. Handle cheap commands without the model: in the command bar (011), navigation and "organize my tabs" go straight to their target by matching; only free-form text is sent to the model.
  6. Never retry a 429; retry a 503 at most once (§16).
  7. Tests never call the model (fake adapter); live checks are opt-in and few.
- **Meter**: `apps/web/src/llm/budget.ts`, an in-memory counter per Pacific-time day (Google's daily quota resets at midnight Pacific), incremented immediately **before** each request (attempts count, not successes). Global cap `LLM_DAILY_CAP` (default 450, leaving headroom under 500). Default shares of that cap by purpose: `cluster` 50, `chat` 170, `plan` 40, `actions` 80, `command` 60, and 50 as a shared spill-over pool a purpose may use after its own share. Over the cap: `BudgetExceededError` (HTTP `429 budget_exhausted`, generic message, nothing changed). In memory is enough for one server process; it resets on restart, which errs toward allowing more calls, so it is a guardrail, not a guarantee.
- **Model routing**: model id per purpose through env (`GEMINI_MODEL`, default `gemini-3.5-flash-lite`; optional `GEMINI_MODEL_CLUSTER`, `_CHAT`, `_PLAN`, `_ACTIONS`, `_COMMAND`). Free-tier quotas are normally per model, so chat and summaries can use a stronger flash model, and the teammate or development can use a different model id, which keeps the demo model's bucket clean. Per-model limits must be read from AI Studio.
- **Not done**: creating extra Google projects or keys to multiply quota (against Google's terms); a second vendor as an automatic fallback (the constitution forbids running the preferred vendor and its pivot as two sources); a persistent usage table (a migration and a query per call for no gain in a one-server demo; revisit if the app is hosted for real users).
- **Demo-day practice**: run clustering ahead of time on the demo tab set. Results are stored, so showing them costs no calls, and repeating the click is skipped as "unchanged".
- **Alternatives considered**: a database-backed counter (extra migration, a query per call); no meter at all (one runaway loop empties the day, which is the failure this section exists to prevent).

## Clarifications

None remaining.
