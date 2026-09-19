# Contract: Clustering HTTP API (004)

Base: the Next.js app in `apps/web` (same host as 003). All routes are under `/api`, use JSON, and follow the 003 conventions: `Authorization: Bearer <deviceToken>` (unknown or missing token → `401`), CORS headers from `src/json.ts`, errors as `{ "error": string, "code"?: string }`. Every query is scoped to the authenticated user; another user's ids are `404`, never `403`.

Types are in [shared-clustering-types.md](./shared-clustering-types.md). The model call behind `POST /api/cluster/runs` is in [model.md](./model.md).

## POST /api/cluster/runs

Run clustering now for the authenticated user. Synchronous; a run is expected to finish in under 30 s for up to 50 tabs.

Request (body optional):

```json
{ "force": false }
```

`force: true` skips the "nothing changed" check.

Response `200`, ran:

```json
{
  "skipped": false,
  "run": { "...": "ClusterRun (status succeeded)" },
  "applied": [ { "workspace": { "...": "Workspace" }, "created": true, "tabRefIds": ["…"] } ],
  "suggestions": [ { "...": "SuggestionView" } ],
  "leftOut": 0
}
```

Response `200`, skipped (no unplaced tab or active workspace changed since the last run; the model was not called):

```json
{ "skipped": true, "reason": "unchanged", "run": null, "applied": [], "suggestions": [], "leftOut": 0 }
```

(`run` is the latest run for reference, or `null` if there is none.)

Nothing found is a normal `200` with `applied: []` and `suggestions: []`. Fewer than two candidate tabs is also that, without a model call.

Errors:

| Status | `code` | Meaning |
| --- | --- | --- |
| `400` | | body is not a JSON object, or `force` is not a boolean |
| `401` | | missing/unknown token |
| `409` | `run_in_progress` | this user already has a run in flight |
| `429` | `budget_exhausted` | the daily AI-call budget is spent, or the AI vendor said its quota is used up; run recorded `failed` (body includes `runId` when a run row exists); nothing changed; not retried |
| `502` | `model_error` | the model timed out, refused, or returned something unusable; body includes `runId`; nothing changed |
| `503` | `model_unconfigured` | no model key configured on the server; no run recorded; nothing changed |

## GET /api/cluster/runs

Query: `limit` (default 20, max 50). Response `200`: `{ "runs": ClusterRun[] }`, newest first, this user only.

## GET /api/cluster/runs/:id

Response `200`: `{ "run": ClusterRun, "moves": [ { "tabRefId": "…", "toWorkspaceId": "…", "stillAiPlaced": true } ] }`. `stillAiPlaced` is `false` when the user has since moved that tab. `404` for an unknown or other user's id.

## POST /api/cluster/runs/:id/undo

Reverts what the run placed. Only tabs still `ai`-placed in the run's workspace are reverted; a tab the user moved keeps the user's placement. Workspaces the run created that are now empty and untouched (not renamed) are archived.

Response `200`:

```json
{ "run": { "...": "ClusterRun (status undone)" }, "reverted": 4, "keptTabRefIds": ["…"], "archivedWorkspaceIds": ["…"] }
```

Undoing an already undone run is `200` with `reverted: 0`. Errors: `404` unknown id; `409` `not_undoable` when the run is `running` or `failed`.

## GET /api/suggestions

Query: `status` = `pending` (default) | `accepted` | `ignored` | `all`. Response `200`: `{ "suggestions": SuggestionView[] }`, newest first; `400` for an unknown `status`. `tabRefs` lists only members that are still unplaced. A pending suggestion with fewer than two such members is withdrawn during this call and not returned.

## POST /api/suggestions/:id/accept

Create the workspace (or reuse the target / a same-named active workspace) and assign the suggestion's still-unplaced tabs to it as the user's own placement.

Response `200`: `{ "suggestion": Suggestion, "workspace": Workspace, "created": boolean, "tabRefs": TabRef[] }`.

Errors: `404`; `409` `not_pending` (already accepted, ignored, or withdrawn); `409` `stale` (fewer than two of its tabs are still unplaced; the suggestion is withdrawn).

## POST /api/suggestions/:id/ignore

Dismiss it. The same group is neither offered again nor auto-applied by a later run, at any confidence, unless its tabs materially change. Response `200`: `{ "suggestion": Suggestion }`. Ignoring an already ignored suggestion is `200`; ignoring an accepted or withdrawn one is `409` `not_pending`.

## GET /api/overview

The Home read: everything in one call.

Query: `includeArchived=true` to include archived workspaces (default: active and saved only).

Response `200`:

```json
{
  "workspaces": [ { "workspace": { "...": "Workspace" }, "tabRefs": [ { "...": "TabRef" } ] } ],
  "other": [ { "...": "TabRef" } ],
  "suggestions": [ { "...": "SuggestionView (pending)" } ]
}
```

`other` holds tabs with no workspace. Every `TabRef` carries `placementSource`.

## Changes to feature 003 routes

Additive, no breaking change to existing responses except the new field:

- Every `TabRef` in a response (`GET/PUT /api/tab-refs`, `PATCH /api/tab-refs/:id`, `GET /api/resolve`) now includes `placementSource: "ai" | "user" | null`. This is how the sidebar learns a tab was AI-placed.
- `PATCH /api/tab-refs/:id` and `PUT /api/tab-refs`: when the request sets `workspaceId` (including `null`), the tab becomes `placementSource: "user"`. If it was `"ai"` and its workspace actually changed, a `corrections` row is written.
- `POST /api/ingest/tabs` (002 feed) is unchanged and never sets `placementSource`.

## Fail if

- A run moves a tab that had `placementSource` `"user"`, or any tab that already belonged to a workspace
- A low-confidence group changes any tab
- A model failure changes any tab or workspace
- Two runs for one user execute at once
- One user's tab, workspace, suggestion, or run appears for another user
- Page titles, URLs, snippets, prompts, or model answers appear in server logs
