# Contract: Action tools HTTP API

Base: the Next.js app in `apps/web`, under `/api/workspaces/:id`. Follows the existing conventions (see 010's [http.md](../../010-workspace-agents/contracts/http.md)): `Authorization: Bearer <deviceToken>` (missing or unknown is `401`), CORS from `src/json.ts`, errors as `{ "error": string, "code"?: string }`, every query scoped to the signed-in person. Another person's workspace or a missing one is `404 { "error": "Workspace not found" }`, never `403`. The reserved id `other` is `400 not_a_workspace` on every route here (FR-039). A path id that is not a UUID is `404`. Types: [shared-types.md](./shared-types.md). Data: [../data-model.md](../data-model.md).

Route guard: the existing `authorizeWorkspace` (`src/agents/guard.ts`). Nothing in this feature logs a token, an argument value, a page, a message, a result, or a service response.

| Route | Purpose | AI request? |
| --- | --- | --- |
| `POST /actions/suggest` | The suggestion pass | one, or none when reused |
| `GET  /actions` | Saved summary, saved queries, latest run per tool | none |
| `POST /actions/:toolId/run` | One click, one run | only if the run is composed or `write_summary` |
| `POST /actions/runs/:runId/intents/:intentId` | The extension reports a browser intent | none |
| `POST /actions/runs/:runId/confirm` | Send the prepared email | none |
| `POST /actions/runs/:runId/cancel` | Cancel the prepared email | none |
| `GET  /summary/export?format=md\|pdf` | The saved summary as a file | none |

## POST /api/workspaces/:id/actions/suggest

The suggestion pass (spec FR-003). The card calls it when a workspace card opens (`force: false`) and when the refresh button is pressed (`force: true`). **It never runs a tool.** It is the only request in the product that asks the AI without a click on an action, and it only proposes buttons.

Body (optional): `{ "force": boolean }` (default `false`).

Response `200`: `SuggestionSet`

```json
{
  "status": "ok",
  "suggestions": [
    { "id": "s1", "toolId": "open_google_searches", "label": "Open searches for Kyoto ryokan", "reason": "You have 3 hotel tabs but no comparison searches yet.",
      "args": { "queries": ["kyoto ryokan with onsen", "kyoto ryokan near gion"], "placeInWorkspace": true },
      "preview": [ { "name": "searches", "value": "kyoto ryokan with onsen · kyoto ryokan near gion" }, { "name": "place in workspace", "value": "yes" } ],
      "effect": "browser", "service": null }
  ],
  "generatedAt": "2026-09-19T18:04:11.000Z",
  "reused": false,
  "note": null
}
```

- **3 to 6** suggestions, best first; **at most one per tool**; only tools that can run for this person; each already validated against its tool's schema (research 5). Fewer than 3 usable: `status: "ok"` with what is usable and `note: "Only 2 fitting actions right now."`. None usable, a failed AI request, or a request that timed out (9 s): `status: "failed"`, `suggestions: []`, and a fixed `note` (`"Couldn't pick actions right now. Try refresh."`); HTTP is still `200` so the card keeps working (FR-008).
- `effect`: `local` (changes only this product), `browser` (opens tabs or saves a file in the person's browser), `external` (creates or posts in a connected service), `email` (prepares an email; sends nothing). `service` names the integration or is `null`. Both are for a small badge; they never list anything else.
- `args` are what the card will send unchanged on click; `preview` is a server-built plain-text rendering of them (titles, hosts, counts, recipient) so the person sees what will be used **before** anything happens.
- `reused: true` when the stored set was returned without an AI request (unchanged workspace, within 5 minutes on open or 30 seconds on refresh). A second call while a pass is running for this person and workspace joins the same pass (no second request).
- Not returned, ever: the catalog, disabled or "connect X" buttons, or any tool whose service is not connected, not rejected, and not allowed for this person (FR-002, FR-006).

Errors: `400 not_a_workspace`, `401`, `404`, `400 invalid_body` (`force` present and not a boolean), `503 model_unconfigured` (no AI key: the card shows its plain note; the 010 agents are unaffected).

## GET /api/workspaces/:id/actions

Everything the actions group needs to draw itself, in one read. **No AI call and no service call.** First marks any of this person's runs `pending` for over 120 seconds as failed (`timed_out`), as 010's reads do.

Response `200`: `WorkspaceActions`

```json
{
  "summary": { "text": "…", "updatedAt": "…", "coverage": { "tabsTotal": 9, "tabsIncluded": 9, "pagesRead": 6 }, "unreadable": 3 },
  "queries": ["kyoto ryokan with onsen"],
  "refsCount": 4,
  "runs": [
    { "id": "…", "toolId": "github_create_issue", "state": "succeeded", "createdAt": "…", "label": "Create a GitHub issue from these tabs",
      "output": { "result": { "kind": "created", "service": "github", "what": "issue" }, "links": [ { "label": "GitHub issue #42", "url": "https://github.com/o/r/issues/42", "id": "42" } ], "steps": [ … ], "refused": [], "stoppedAtLimit": false },
      "error": null }
  ]
}
```

- `runs`: the **latest run of each tool** in this workspace (tool ids only; agent runs are not here), newest first, at most 20, including any `running` one. A `running` run that is waiting for the browser carries `awaitingIntents` so the card that clicked it can execute them (extension contract, below).
- `summary`, `queries`, and `refsCount` let the card show the saved material the actions used and produced.
- Mail results are never in this response (they are never stored). A mail-search run appears as `{ "kind": "mail_search", "shown": 3 }`.
- The card calls this on open and then every 3 seconds **only while some run is `running`** (FR-046).

Errors: `400 not_a_workspace`, `401`, `404`.

## POST /api/workspaces/:id/actions/:toolId/run

One click of one button: **one run of one tool** (FR-010, FR-011). Nothing else starts a run.

Body: `{ "args": { … }, "label": "…" }`. `args` is the suggestion's prefilled arguments, sent unchanged (**locked**, research 6); it may be `{}` for a tool with nothing to prefill. `label` is the button's text, kept on the run for display (cut to 80 characters; never used as an instruction).

Checks, in this order; the first that fails answers and **nothing is stored**:

| Status | `code` | Meaning | Message (fixed) |
| --- | --- | --- | --- |
| `400` | `not_a_workspace` | the id is `other` | "Actions are for a workspace. Move these tabs into a workspace first." |
| `401` / `404` | | not signed in / workspace not found | as elsewhere |
| `404` | `unknown_tool` | `:toolId` is not in the catalog | "There is no such action." |
| `403` | `not_available` | Drive or Gmail tool for anyone but the owner | "That action isn't available." (the same sentence whether or not Google is connected) |
| `409` | `not_connected` | the tool's service is missing or its credential was rejected | "Connect {service} to use this action." (Google: "Connect Google …") |
| `400` | `invalid_body` | body is not an object, `args` is not an object, or an unknown argument name | "That request wasn't in the expected form." |
| `400` | `bad_input` | a present argument fails its schema, is over its limit (`too_long`), is empty where a required detail is needed and no model step could fill it, names a target that is not allowed, or is a `visible` argument that is missing | a fixed sentence naming the argument and the limit, never its value |
| `409` | `precondition` | the tool's precondition fails (no saved summary: "Write a summary first."; no web tabs) | fixed per tool |
| `409` | `run_in_progress` | this tool is already running for this workspace | "This action is already running." |
| `429` | `too_many_runs` | this person already has 5 runs going | "Several actions are already running. Wait for one to finish." |
| `503` | `model_unconfigured` | the run needs the AI (composed, or `write_summary`) and no key is set | "The AI assistant isn't set up on this server yet." |

Response for every tool except mail search: `202 { "run": ToolRunView }` with `state: "running"`. The run continues on the server whether or not the caller stays (same job model as 010, research 1 of 010). Failures after the run started (a service is down, a credential was rejected, the AI failed, a limit was reached, the browser did not respond) are **never** an HTTP error: they appear as a run with `state: "failed"` and an `error` in the next read.

Response for `gmail_search_messages` only: `200 { "run": ToolRunView, "mail": { "messages": [ { "from", "subject", "date", "excerpt" } ] } }`, computed inside the request (the run already finished). `mail` is present **only** in this response.

Run `error.code` values: `not_connected`, `rejected_credentials`, `service_error` (the service failed or timed out), `bad_input`, `no_summary`, `step_limit` (stopped at the limit; `partial` says what was found), `refused_only` (the only thing the AI tried was refused), `budget_exhausted`, `model_error`, `bad_answer`, `browser_failed` (the browser reported failure or did not respond), `timed_out`. Messages are fixed sentences ending "You can try again." where retrying makes sense; **never** text from a service, a page, an email, or the AI; never a token or a secret.

## POST /api/workspaces/:id/actions/runs/:runId/intents/:intentId

The extension reports the outcome of a browser intent for a run it started (research 10). Body: `{ "status": "done" | "failed", "opened": number, "failed": number, "placed": number }` (counts default to 0; `opened + failed` may not exceed the intent's address count).

Effect: finishes the run: `done` with `opened > 0` is `succeeded` (the result says exactly how many opened, how many were skipped or failed, and how many were placed in the workspace); `failed`, or `opened = 0`, is `failed` with `browser_failed`. A download intent has no counts. Only a run that is `pending` and still awaiting that intent can be reported; the finish is conditional on `status = 'pending'`, so a report that arrives after the 120-second stale rule changed the run changes nothing.

Response `200`: `{ "run": ToolRunView }`. Errors: `404` (run or intent not found for this person and workspace), `409 already_reported`, `400 invalid_body`, `401`.

## POST /api/workspaces/:id/actions/runs/:runId/confirm

Send the prepared email (spec FR-035). Body: `{ "to": "person@example.com" }`.

Sends the **stored** subject and body of that `email_preview` run to `to`, once. The preview must be `unsent`, under 30 minutes old, and belong to this person and workspace; the recipient must be exactly one valid address (no commas, no line breaks, no display name). The server marks the preview `sending` with a conditional update before calling Gmail, so a repeated or concurrent confirm cannot send twice.

Response `200`: `{ "run": ToolRunView }` (the new send run, `succeeded` or `failed`; a success shows "Sent to {to}." and the message link when returned). Errors: `404` (not a preview of this person's workspace), `409 already_sent`, `409 cancelled`, `409 expired` ("This message was prepared too long ago. Prepare it again."), `400 invalid_recipient`, `409 not_connected` / `403 not_available` (checked again at send time).

## POST /api/workspaces/:id/actions/runs/:runId/cancel

Marks an `unsent` preview `cancelled`; nothing is sent. Response `200 { "run": ToolRunView }`. Errors as above (`409 already_sent`).

## GET /api/workspaces/:id/summary/export?format=md|pdf

Returns the saved summary as a file: `200` with `Content-Type: text/markdown; charset=utf-8` or `application/pdf`, `Content-Disposition: attachment; filename="{workspace name}-summary.{md|pdf}"` (name sanitized to letters, digits, dash, and space), `Cache-Control: no-store`. The text is exactly the saved summary (Markdown adds a title line and the coverage note; PDF is a simple text document, text outside Latin-1 replaced by `?`). Used by the extension's download intent; also usable by any authorized client.

Errors: `409 no_summary` ("Write a summary first." and **no empty file**, FR-022), `400 invalid_format`, `400 not_a_workspace`, `401`, `404`.

## The extension side (browser intents)

The server never contacts the extension. The card that made the click executes the intents of runs **it started in this session**, then reports (research 10):

| Intent | The card's host does | Limits |
| --- | --- | --- |
| `open_tabs` `{ urls, placeInWorkspace }` | `chrome.tabs.create({ url, active: false })` for each `https` address (re-checked), at most 5; if `placeInWorkspace`, resolve the new tab and move it with 007's existing call, retrying a few times | never closes, moves, or changes an existing tab (FR-029); no new manifest permission |
| `download` `{ format, filename }` | `fetch` the export route with the bearer token, build a blob, trigger a download from the extension page | the file is what the route returned |

A Home reload, a second window, or any poll **never** executes an intent (only the in-memory set of this session's own click run ids does). A run whose intent is never reported ends `failed` by the 120-second stale rule, with `browser_failed`; nothing is shown as opened.

## Rules for clients (Home now, the sidebar later)

1. **Render everything as plain text.** Results, previews, links, and ids are text. A link is drawn as its label and address text and opened only by an explicit click through the host's open-tab behavior, for `https` addresses only. Never render HTML or markdown; never load anything remote.
2. Show the button's `reason` and `preview`. Show a run's state under its button: idle, running, done, failed; show failed runs' fixed message with a way to click again. Do not retry automatically (FR-017).
3. Poll `GET /actions` every 3 seconds **only** while some run is `running`.
4. Never show the whole catalog. Draw a button for each suggestion and nothing else (FR-005).
5. After a successful run the card **may** ask for suggestions again; it must keep buttons under the cursor stable while it does (draw the new set only when the person is not hovering or focused on the group, otherwise offer "New suggestions" that swaps them on click).
6. Treat `409 run_in_progress` as "already running", not an error to retry.
7. For a prepared email, show the exact `subject` and `body` read-only and the recipient as an editable field with **Send this message** and **Cancel**; disable Send while the recipient is empty or invalid.
8. When the server cannot be reached, keep what is on screen, show one plain note, stop polling, and never invent a result or a "sent" state.

## Not in this feature

A tool catalog or "all actions" screen, custom tools or servers, credential entry, per-person credentials, editing prefilled arguments before the click (the person may instead edit the recipient of a prepared email), scheduling or repeating actions, deleting service items, the sidebar screen, and the ⌘K command bar.
