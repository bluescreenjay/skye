# Quickstart: AI Clustering (004)

Proves that a messy tab set becomes named workspaces, that uncertain groups become suggestions, that user placements are never overridden, and that everything is reversible. No Home or Sidebar UI is involved; everything is driven with `curl`.

Contract: [contracts/http.md](./contracts/http.md). Model behavior: [contracts/model.md](./contracts/model.md).

## Prerequisites

- Features 001–003 working (`pnpm install`, the API runs against your database).
- `DATABASE_URL` and `DEVICE_TOKEN_SECRET` in the repo-root `.env`.
- **An AI provider key in the repo-root `.env`.** Default: `VT_LLM_API_KEY` (a personal Virginia Tech key), and **you must be on the VT Campus VPN** for the live steps. Backup: `LLM_PROVIDER=gemini` with `GEMINI_API_KEY` (any network). The automated checks use a fake model and need neither.
- Optionally `LLM_MODEL`, `LLM_CONCURRENCY`, `GEMINI_MODEL`, `CLUSTER_CONFIDENCE_BAR` (defaults in [contracts/model.md](./contracts/model.md)).
- The fixture files created during implementation, in `apps/web/tests/fixtures/`: `mixed-tabs.batch.json` (a ready-to-send batch: 30 tabs across three topics, a small deliberately ambiguous group, and a few one-offs), `mixed-tabs-50.batch.json` (50 tabs, for timing), and `mixed-tabs.labels.json` (the answer key).

## Automated checks (no network, no key)

```bash
pnpm -r typecheck
pnpm --filter @ai-browser/web test      # PGlite + a fake model; covers apply, suggest, undo, races, isolation, repeat runs
pnpm --filter @ai-browser/extension test
```

## Apply the schema change (writes to your database)

The migration is idempotent (`IF NOT EXISTS`, guarded backfill), so running it twice is harmless. It changes the database named in `DATABASE_URL`: `tab_refs` gains a column, and three tables are added.

```bash
node apps/web/scripts/apply-sql.mjs packages/shared/sql/004_clustering.sql
```

(`psql` is not required.)

## Confirm the model id (once)

VT (default, needs the VPN): `curl -s https://llm-api.arc.vt.edu/api/v1/models -H "Authorization: Bearer $VT_LLM_API_KEY" | python3 -c 'import sys,json;[print(m["id"]) for m in json.load(sys.stdin)["data"]]'`. Check that `gpt-oss-120b` and `gpt-oss-120b-thinking-low` are listed.

Gemini (backup): list the models with `x-goog-api-key`, and check `gemini-3.5-flash-lite`. Listed does not mean callable (`gemini-2.5-flash` is listed but returns 404 for new users). Either way, the first live run in V1 is the real check.

## Run

```bash
pnpm --filter @ai-browser/web dev
export B=http://localhost:3000
export T1=e2e-cluster-$(date +%s)-aaaaaaaa      # a fresh token = a fresh, empty user
export T2=e2e-cluster-$(date +%s)-bbbbbbbb
export H1="Authorization: Bearer $T1"
```

## Scenarios

### V1: messy tabs become named workspaces (US1, SC-001)

```bash
curl -s -X POST $B/api/ingest/tabs -H "$H1" -H 'content-type: application/json' \
  -d @apps/web/tests/fixtures/mixed-tabs.batch.json
curl -s -X POST $B/api/cluster/runs -H "$H1" -H 'content-type: application/json' -d '{}' | python3 -m json.tool
curl -s $B/api/overview -H "$H1" | python3 -m json.tool | head -80
```

Expect: three or four named workspaces (each with an emoji) holding the matching tabs; one-off tabs still in `other`; `applied` non-empty; `run.status` `succeeded`. Compare against `mixed-tabs.labels.json`: at least 80% of tabs are where the labels say (SC-001). The score script prints this: `node apps/web/scripts/score-clusters.mjs $T1` (created during implementation).

### V2: low confidence suggests, never moves (US2, SC-004)

Live models tend to report 0.85–0.95 for clear groups, so V1 may produce few or no suggestions. Force them: stop the server, start it with `CLUSTER_CONFIDENCE_BAR=0.97`, use a fresh token, ingest the fixture again, and run clustering. Then look at `suggestions` in the run output or `GET /api/suggestions`. Each pending suggestion has a name, emoji, confidence below the bar, and tabs. Confirm those tabs are still in `other` in `/api/overview`.

```bash
curl -s $B/api/suggestions -H "$H1" | python3 -m json.tool
SID=<a suggestion id>
curl -s -X POST $B/api/suggestions/$SID/accept -H "$H1" | python3 -m json.tool   # workspace created, tabs moved
```

Ignore another one with `POST /api/suggestions/<id>/ignore`, then re-run with `{"force":true}`: the ignored group must not come back, and it must not be auto-applied even if you restart the server at the normal bar (`0.7`) and force another run.

### V3: existing workspaces and user placements are respected (US3, SC-003)

```bash
# a hand-made workspace and a hand-placed tab
WID=$(curl -s -X POST $B/api/workspaces -H "$H1" -H 'content-type: application/json' -d '{"name":"Trip to Japan","emoji":"🗾"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["workspace"]["id"])')
```

Ingest a few more Japan-related tabs (edit a copy of the fixture or add tabs by hand), assign one to `$WID` with `PATCH /api/tab-refs/<id>` `{"workspaceId":"…"}`, run clustering. Expect: the new Japan tabs join `$WID` (no second Japan workspace); the hand-placed tab is untouched and reports `placementSource: "user"`.

### V4: everything is reversible (US4, SC-002)

```bash
RID=<run id from V1>
curl -s -X POST $B/api/cluster/runs/$RID/undo -H "$H1" | python3 -m json.tool
```

Expect: `reverted` equals the tabs the run moved (minus any you moved by hand, listed in `keptTabRefIds`); workspaces the run created and that are now empty are in `archivedWorkspaceIds`; `/api/overview` shows those tabs back in `other`. Then:

1. Run again with no changes (no `force`): `skipped: true`, no model call (SC-005).
2. Move an AI-placed tab by hand (`PATCH`), run with `{"force":true}` after adding tabs: that tab does not move, and `GET /api/resolve?chromeTabId=<id>` shows `placementSource: "user"`.

### V5: repeat runs are quiet (SC-005)

Run twice in a row without `force`. The second answers `{"skipped": true, "reason": "unchanged"}` and `GET /api/suggestions` shows no duplicates.

### V6: failure changes nothing (SC-007)

Stop the server, clear or break the active provider's key (`VT_LLM_API_KEY`, or `GEMINI_API_KEY` with `LLM_PROVIDER=gemini`; or set an invalid one), restart, run clustering. Expect `503 model_unconfigured` (no key) or `502 model_error` (bad key), and `/api/overview` identical to before. Restore the key afterwards.

### V7: one run at a time, and isolation (SC-008)

Send two `POST /api/cluster/runs` at once: one gets `200`, the other `409 run_in_progress`. Run with `$T2` (a different user): `GET /api/overview` and `GET /api/suggestions` for `$T2` show none of `$T1`'s workspaces, suggestions, or runs.

### V8: the sidebar read (US5, SC-009)

```bash
curl -s "$B/api/resolve?chromeTabId=<id of an AI-placed tab>" -H "$H1"
```

Expect the workspace and `tabRef.placementSource: "ai"`. `GET /api/overview` returns workspaces with tabs, Other, and pending suggestions in one response.

### V9: timing (SC-006)

Ingest `mixed-tabs-50.batch.json` under a fresh token and time the run (`time curl …`); repeat with `{"force":true}` after undoing (V4) so each timing is a real model call: under 30 s in at least 9 of 10 runs. This spends about 10 model requests, so watch the daily budget.

### V10: the daily budget holds (research §18)

Start the server with `LLM_DAILY_CAP=1`, run clustering once (`200`), then again with `{"force":true}`: expect `429 budget_exhausted`, a `failed` run in `GET /api/cluster/runs`, and no change in `/api/overview`. Restart without the variable afterwards.

### V11: the provider switch and the VPN (research section 19)

With the default provider, turn the VT VPN off and run clustering: expect `502 model_error` whose message says the service is only reachable on the VT VPN and names `LLM_PROVIDER=gemini`, and no change to `/api/overview`. Restart with `LLM_PROVIDER=gemini` (and `GEMINI_API_KEY`) and run again: it works from any network. To see the concurrency handling, fire more than 10 simultaneous runs from different tokens: every one should succeed (the local limiter queues them) or, at worst, end as `429 budget_exhausted` ("busy"), never as a crash.

## Done when

Every V-row passes, the automated checks are green, and the live V1 score is at least 80%.

## Fail if

- Any run moves a `placementSource: "user"` tab or a tab that was already in a workspace
- A below-confidence group changes a tab
- A model or network failure leaves any tab or workspace changed
- Duplicate workspaces or suggestions appear after repeat runs
- Server logs contain page titles, URLs, snippets, or model output
- An AI provider key (`VT_LLM_API_KEY`, `GEMINI_API_KEY`) or a real device token is committed
- A Home or Sidebar screen, or in-browser tab moving, is built in this feature
