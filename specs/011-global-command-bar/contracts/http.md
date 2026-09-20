# Contract: Command bar HTTP API

Base: the Next.js app in `apps/web` (same host as 003 to 010). Three routes under `/api/command`. They follow the existing conventions: `Authorization: Bearer <deviceToken>` (missing or unknown token is `401`), CORS headers from `src/json.ts`, JSON errors as `{ "error": string, "code"?: string }`, every query scoped to the signed-in person. Types: [shared-command-types.md](./shared-command-types.md). Data: [../data-model.md](../data-model.md). Only ordinary JSON route handlers, as the existing routes are (`apps/web/AGENTS.md` warns Next 16 differs; implementers read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` first, as 008 and 010 did).

No route here fetches a page, calls an outside service, or runs a 010b tool. Opening the bar and typing are not requests at all.

## POST /api/command: interpret (the one AI request)

Body: `CommandRequest` `{ text, context }`. **Changes nothing.** Makes exactly one AI request, except when refused before it (below).

Steps: check the body; build the material from the person's own non-archived workspaces and tabs; ask the model once ([model.md](./model.md)); validate; resolve names and "this workspace" by the spec's rules; answer with a `CommandReply`.

Response `200`: `CommandReply`. Which reply for which intent:

| Model `intent` | Reply |
| --- | --- |
| `organize`, `cleanup` | `action` (`understood`: "Organizing your 12 loose tabs."). With no loose tabs: `say` "There are no loose tabs to organize." (no organize request is started) |
| `group` | `action { group }` when at least 2 tabs matched and a target is known; else `say` "No open tabs match that." |
| `move` | `action { move }` when the tabs and destination resolve; `ask` when the destination or subject matches two; `say` when a named workspace does not exist ("There's no workspace called X. Yours are: …") |
| `rename` | `action { rename }`; `say` when the workspace or the new name is missing; `ask` if two workspaces match |
| `merge` | `action { merge }`; `say` for a self-merge or a missing workspace; `ask` if a name matches two |
| `create` | `action { create }` with the name the person gave, else a name from the model; `say` "I couldn't tell what to call it. Say \"create a workspace called …\"." when there is no usable name. When the name is already a workspace: `ask` "That workspace already exists. Add these tabs to it instead?" with one choice whose step is a `move` action into the existing workspace (so it still confirms) |
| `show` | `navigate { home }` |
| `open_workspace` | `navigate { workspace }`; `ask` for two matches; `say` for none |
| `find` | `found`; `say` "Nothing matched. Try different words." when the model returned nothing valid |
| `recall` | `recalled`; `say` "Nothing was recorded for {period}." when the period has no activity; `say` "That day hasn't happened yet." for a future date |
| `undo` | `action { undo }` |
| `agent` | `action { agent }` for one match or the current workspace; `ask` for two; `say` for none or when "this workspace" cannot be resolved (with the reason: none expanded, several expanded, or the tab is in Other and an offer to pick one) |
| `clarify`, or `confidence` below 0.6 | `ask` with `submit` choices for the intents the model was torn between (fixed phrases), else `say` "I wasn't sure what you meant." with `help` |
| `multiple` | `ask` "I do one thing at a time. Which first?" with a `submit` choice for each verbatim part |
| `unsupported` | `say` "I can't do that." with `help`. For `reason: page_content`: `ask` "I can find your tabs, but I can't answer questions about what's inside them." with one `submit` choice, "Find the tab", whose text is the fixed prefix `find the tab: ` plus the person's own words (cut to 300); a fixed prefix and verbatim words, so no model text reaches the button |

`help` is the same fixed list of about six example commands the bar shows when it opens.

Refusals (JSON errors; no AI request is made unless the row says so):

| Status | `code` | When | Message (fixed) | AI request made? |
| --- | --- | --- | --- | --- |
| `400` | `text_empty` | empty or whitespace-only text | "Type a command first." | no |
| `400` | `text_too_long` | more than 300 characters | "That command is too long. Shorten it and try again." | no |
| `400` | `bad_context` | malformed `context` | "Something went wrong reading where you are. Try again." | no |
| `400` | `bad_time_zone` | unknown IANA zone | same wording as `bad_context` | no |
| `401` | | missing or unknown token | | no |
| `429` | `budget_exhausted` | the daily AI allowance or the vendor's quota is used up | "The daily AI limit has been reached. Try again tomorrow." (quota wording differs, see `describeFailure`) | no request goes out |
| `502` | `model_error` | timeout, HTTP error, or an unusable answer | "The AI assistant couldn't understand that right now. Your words are still here; try again." | yes |
| `503` | `model_unconfigured` | no AI key on the server | "The AI assistant isn't set up on this server yet." | no |
| `503` | `busy` | the service stayed busy until the deadline | "The AI assistant is busy right now. Try again in a moment." | yes |

The mapping from the shared AI layer's typed errors to these sentences reuses `describeFailure` (busy, quota, daily, VPN, generic), so a person sees the same situations they see in chat and agents; the VPN case says "The AI service is only reachable on the VT VPN. Connect to it and try again." A failure stores nothing and changes nothing.

## POST /api/command/apply: do it (server decides whether to confirm)

Body: `{ "action": CommandAction, "confirmed": boolean }` (`confirmed` defaults to false). Not used for `agent` actions (the client presses those through the 010 route).

Response `200`: `CommandApplyResult`.

- `needs_confirmation`: returned, with a `ChangePreview` and **nothing changed**, when the action needs confirmation (research 2) and `confirmed` is not `true`. Re-checked against the current state each time.
- `done`: the change was made (or the organize/undo ran). Carries the counts, the plain `message`, the current `UndoState` (or `null`), `next: "scan_duplicates"` for `cleanup`, and the workspace to link to.
- `nothing_to_do`: no change (nothing to organize, tabs already there, "There is nothing to undo."). The undo state is unchanged.
- `refused`: the action cannot run as asked; nothing changed. `code` says why (`name_taken`, `not_found`, `same_workspace`, ...). A workspace or tab that vanished since the reply is `not_found` with "That workspace or those tabs changed. Ask again." (edge case: resolve against current state).

HTTP errors: `400 bad_action` (not one of the shapes above, or a malformed id), `401`, and for `organize`/`cleanup` the organize path's own conditions as `refused` (never a 4xx/5xx that hides the state): `run_in_progress` (organize already running: "Already organizing."), `budget_exhausted`, `model_error`, `model_unconfigured`. An unexpected failure is `500 { "error": "The command failed" }` and is logged by class name only.

Per action:

| Action | What the server does | Undo row |
| --- | --- | --- |
| `organize` | `runClustering(userId)` (the function behind `POST /api/cluster/runs`). Skipped-because-unchanged or zero applied is `nothing_to_do` ("Nothing to organize.") | `{ runId }` when it applied at least one tab |
| `cleanup` | The same organize step; `done` with `next: "scan_duplicates"` even when nothing was organized (the duplicate scan is still offered). The extension then does the scan | as `organize` |
| `group` | Resolves the target (existing workspace id, else existing name, else create). Always confirms. Moves the still-existing tabs that are not already there | `moves` (+ `createdWorkspaceId`) |
| `move` | Destination must be an active workspace or `null` (Other). Always confirms | `moves` |
| `rename` | Name rules (research 8). Always confirms with old and new names | `rename` |
| `merge` | Moves every tab of the source. Refuses same workspace, or a missing one. Always confirms with both names and the tab count | `moves` |
| `create` | Makes the workspace and moves the tabs. Confirms only if any tab is `user`-placed | `moves` + `createdWorkspaceId` |
| `undo` | The undo rules in data-model.md | row deleted |

Every changing action: takes the per-person advisory lock; runs in one transaction; writes one `reassigned` event per moved tab, and a `corrections` row per AI-placed tab that changed workspace; then writes or replaces the undo row. A failure inside rolls all of it back.

## GET /api/command/undo: what can be undone

Response `200`: `{ "undo": UndoState | null }`. `null` when there is no row or it is older than 10 minutes (the row is then removed). Makes no AI request. The bar calls this when it opens, so a reopened bar still offers Undo (User Story 6 scenario 8).

## What none of these do

They do not read or fetch a page; they do not archive or delete a workspace on the person's command; they do not touch chat, plan items, or agent runs; they never write a command, a tab title, or a result to a log or an error message.
