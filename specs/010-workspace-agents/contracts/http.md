# Contract: Workspace agents HTTP API

Base: the Next.js app in `apps/web` (same host as 003, 004, and 008). Four routes under `/api/workspaces/:id`. They follow the existing conventions: `Authorization: Bearer <deviceToken>` (missing or unknown token is `401`), CORS headers from `src/json.ts`, JSON errors as `{ "error": string, "code"?: string }`, and every query scoped to the signed-in person. Another person's workspace id, or a workspace that does not exist, is `404 { "error": "Workspace not found" }`, never `403`. Types: [shared-agent-types.md](./shared-agent-types.md). Data: [../data-model.md](../data-model.md).

The reserved id `other` (tabs with no workspace) is `400 not_a_workspace` on every route here. A path id that is not a UUID is `404`.

## GET /api/workspaces/:id/agents

The whole card in one read: the fixed list of agents, each with its latest finished result, its running run (if any), and its latest failure (only if newer than the latest finished result), plus the workspace's checklist. Makes **no** AI call and no page request. It first marks any run that has been `running` for over 120 seconds as failed (`timed_out`), so a run whose server stopped never shows as running forever. The card calls this on open, and again every 3 seconds only while some agent shows `running`.

Response `200`: `WorkspaceAgents`

```json
{
  "agents": [
    {
      "id": "summarize", "name": "summarize", "description": "a short summary of what your sources say", "kind": "text",
      "latest":   { "id": "…", "agentId": "summarize", "state": "succeeded", "createdAt": "…", "input": { … }, "output": { "result": { … }, "sources": [ … ], "coverage": { … } }, "error": null },
      "running":  null,
      "lastFailed": null
    }
  ],
  "planItems": [ { "id": "…", "userId": "…", "workspaceId": "…", "text": "Book the ryokan", "done": false, "sortOrder": 0 } ]
}
```

The five agents, in this order: `summarize`, `compare`, `missing`, `next-steps`, `refs` (names: "summarize", "compare", "what's missing", "next steps", "collect refs"). Errors: `400 not_a_workspace`, `401`, `404`.

## POST /api/workspaces/:id/agents/:agentId/run

Press an agent. No body. **Returns at once** with a run in the `running` state; the run continues on the server whether or not the caller stays.

Response `202`: `{ "run": AgentRunView }` with `state: "running"`, `output: null`, `error: null`.

Everything that can be refused is refused **before** a run is stored, as an ordinary JSON error:

| Status | `code` | Meaning | Message (fixed) | Run stored? |
| --- | --- | --- | --- | --- |
| `400` | `not_a_workspace` | the id is `other` | "Agents are for a workspace. Move these tabs into a workspace first." | no |
| `401` | | missing or unknown token | | no |
| `404` | | workspace not found (or another person's) | "Workspace not found" | no |
| `404` | `unknown_agent` | `:agentId` is not one of the five | "There is no such agent." | no |
| `409` | `run_in_progress` | this agent is already running for this workspace | "This agent is already running for this workspace." | no |
| `409` | `no_tabs` | the workspace has no web (http or https) tabs | "Add some web tabs to this workspace first, then run an agent." | no |
| `429` | `too_many_runs` | this person already has 3 runs going | "Several agents are already running. Wait for one to finish." | no |
| `503` | `model_unconfigured` | no AI provider key on the server | "The AI assistant isn't set up on this server yet." | no |

Failures **after** the run started (the AI service is down, busy, over its allowance, off its required network, an unusable answer, or the run did not finish) never change this response: they appear as a run with `state: "failed"` and an `error` in the next read (below). No AI request is made for a refused press, and none is made without a press.

## GET /api/workspaces/:id/agents/:agentId/runs

An agent's stored runs in this workspace, newest first. No AI call.

Query: `limit` (default 10, max 10) and `before` (a run id: return only runs older than that one). Response `200`: `{ "runs": AgentRunView[], "hasMore": boolean }`. Runs are the latest 10 at most (plus the preserved latest finished result if it is older). Errors: `400 invalid_cursor` (`before` is not a run of this agent in this workspace), `400 not_a_workspace`, `401`, `404`, `404 unknown_agent`.

## PATCH /api/workspaces/:id/plan-items/:itemId

Tick or untick one checklist item.

Body: `{ "done": boolean }`. Response `200`: `{ "planItem": PlanItem }`. Errors: `400 invalid_body` (not an object, or `done` is not a boolean), `400 not_a_workspace`, `401`, `404` (workspace or item not found, or not this person's; an item id that is not a UUID is `404`).

## Run states and what `error.code` can be

`state` is `running`, `succeeded`, or `failed`. A `failed` run has `output: null` and an `error`:

| `error.code` | When | Message (fixed) |
| --- | --- | --- |
| `budget_exhausted` | busy, the vendor's quota, or the daily allowance | one of: "The AI assistant is busy right now. You can run it again in a moment." / "The AI service's quota has been reached. You can run it again later." / "The daily AI limit has been reached. You can run it again tomorrow." |
| `model_error` | unreachable, timed out, errored, or the required network is off | "The AI assistant couldn't run this right now. You can run it again." or, for the VPN: "The AI service is only reachable on the VT VPN. Connect to it and run it again." |
| `bad_answer` | the AI's answer could not be used | "The AI's answer could not be used. You can run it again." |
| `timed_out` | the run did not finish (job limit, or the server stopped and the run went stale) | "This run did not finish. You can run it again." |

Messages never contain the prompt, tab or page text, a result, a quote, or the AI service's own words.

## Rules for clients (the Home card now, the sidebar later)

1. **Render results as plain text.** A result, a quote, a title, or a checklist item is text. Never render it as HTML or markdown, and never load an image, embed, or link from it automatically. A quote's address is shown as the tab's title; opening it is an explicit click on the person's own tab address.
2. Show `coverage` and any `sources` with a `reason` ("read 6 of 9 tabs; 3 could not be read: needs sign-in, …") so people know what a result covers.
3. Poll `GET …/agents` every few seconds **only** while some agent is `running`; stop when none is. Do not poll idle cards.
4. A `failed` run is never a result: show its message and a way to run again. Keep showing `latest` (the last finished result) when a newer run failed.
5. Only the current checklist (`planItems`) is tickable. An older `next-steps` run shows what it proposed and is read-only.
6. Treat `409 run_in_progress` as "already running", not an error to retry.
7. When the server cannot be reached, keep what is on screen, show one short plain note, and stop polling; never invent a result or a running state.

## Not in this feature

Custom agents, running an agent on a chosen subset of tabs, deleting or editing runs, adding or editing plan items by hand, exporting or creating documents, streaming a result as it is written, the sidebar screen, and any change to how tabs are organized.
