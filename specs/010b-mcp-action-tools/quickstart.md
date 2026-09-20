# Quickstart: Action Tools (010b)

Proves, end to end, that a workspace card shows a few fitting buttons and never the catalog; that nothing runs without a click and each click is one bounded, saved run; that the local tools give real files, tabs, and saved material; that an outside-service action makes exactly the intended request and shows its link; that email is never sent without the exact-message confirmation; that Google is the owner's alone and mail never reaches the AI; and that nothing crosses a workspace, a person, or a secret. Automated checks use fakes and need no account, key, or network. The live steps use a real AI key and, optionally, real services.

Contracts: [contracts/http.md](./contracts/http.md), [contracts/tools.md](./contracts/tools.md), [contracts/model.md](./contracts/model.md), [contracts/integrations.md](./contracts/integrations.md). Data: [data-model.md](./data-model.md).

## Prerequisites

- Features 001 to 005, 008, and **010 (agents)** working. `pnpm install` (this feature adds `@modelcontextprotocol/sdk` to `apps/web`).
- Apply the migration (writes to your database; safe to repeat). **Ask before running it against the shared database**:

```bash
node apps/web/scripts/apply-sql.mjs packages/shared/sql/010b_actions.sql
```

- For live steps: an AI provider key in the repo-root `.env` (`VT_LLM_API_KEY` on the VT VPN, or `LLM_PROVIDER=gemini` with `GEMINI_API_KEY`; pace Gemini to 15 requests a minute). Service credentials are optional and are set only as environment variables (contracts/integrations.md). **Never `source` the `.env` in a shell.**

## Automated checks (no network, no key, no account)

```bash
pnpm -r typecheck
pnpm --filter @ai-browser/web test          # PGlite + ScriptedActionModel + fake MCP server + scripted fake connector
pnpm --filter @ai-browser/extension test    # pure helpers; manifest (no new permission); observe-only (no chrome.* in shared UI)
```

Optional live checks (in-process database, never Tiger; each is opt-in and skipped by default):

```bash
ACTIONS_LIVE=1 pnpm --filter @ai-browser/web test actions-live --disable-console-intercept          # suggestion pass + a composed run, real provider
ACTIONS_LIVE_GITHUB=1 pnpm --filter @ai-browser/web test actions-live --disable-console-intercept   # read-only tools/list probe; also JIRA, NOTION, SLACK, GOOGLE
```

## Set up a workspace

```bash
pnpm --filter @ai-browser/web dev
export B=http://localhost:3000
export T1=e2e-actions-$(date +%s)-aaaaaaaa
export H="Authorization: Bearer $T1"; export J='content-type: application/json'
curl -s -X POST $B/api/session -H "$J" -d "{\"deviceToken\":\"$T1\"}"      # note the userId (the owner id, if you will test Google)
export WID=$(curl -s -X POST $B/api/workspaces -H "$H" -H "$J" -d '{"name":"kyoto trip"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["workspace"]["id"])')
for U in "https://en.wikipedia.org/wiki/Kyoto" "https://en.wikipedia.org/wiki/Fushimi_Inari-taisha" "https://en.wikipedia.org/wiki/Gion,_Kyoto"; do
  curl -s -X PUT $B/api/tab-refs -H "$H" -H "$J" -d "{\"url\":\"$U\",\"title\":\"$(basename $U)\",\"snippet\":\"\",\"workspaceId\":\"$WID\"}" >/dev/null
done
```

## Scenarios

### V1: a few fitting buttons, never the catalog (US1; FR-002 to FR-009; SC-001, SC-003, SC-016)

```bash
time curl -s -X POST $B/api/workspaces/$WID/actions/suggest -H "$H" -H "$J" -d '{}' | python3 -m json.tool
```

Expect: `status: "ok"`, **3 to 6** suggestions, best first, each with `label`, `reason`, `toolId`, `args`, `preview`; **only local tools** (no service is connected); one per tool; within 10 seconds; `reused: false`. Repeat within 30 seconds with `{"force": true}`: `reused: true`, no new AI request (check the server's usage counter or the provider). Nothing ran: `GET $B/api/workspaces/$WID/actions` shows `runs: []`, no summary, no queries.

### V2: no click, no run; one click, one saved run (US2; FR-010 to FR-017; SC-002, SC-005, SC-008)

```bash
curl -s $B/api/workspaces/$WID/actions -H "$H"                        # still no runs after the suggestions above
curl -s -X POST $B/api/workspaces/$WID/actions/save_search_queries/run -H "$H" -H "$J" -d '{"args":{"queries":["kyoto ryokan with onsen","gion walking route"]},"label":"Save these searches"}'
# 202 { run: state "running" }; a second identical press while it runs: 409 run_in_progress
curl -s $B/api/workspaces/$WID/actions -H "$H" | python3 -m json.tool   # succeeded, saved 2, queries listed; restart the server and repeat: same result
```

Expect: exactly one run; reload shows the same result; a repeat click is a **new** run and the duplicates are skipped (`skippedDuplicates: 2`). Ask the workspace chat "what searches did I save?": it sees them (US4 scenario 4).

### V3: write and export a summary (US3; SC-004)

```bash
curl -s -X POST $B/api/workspaces/$WID/actions/write_summary/run -H "$H" -H "$J" -d '{"args":{}}'   # one AI request; poll GET /actions
curl -s "$B/api/workspaces/$WID/summary/export?format=md"  -H "$H" | head
curl -s "$B/api/workspaces/$WID/summary/export?format=pdf" -H "$H" -o /tmp/kyoto.pdf && file /tmp/kyoto.pdf   # PDF document
curl -s -X POST $B/api/workspaces/$WID/actions/compose_share_link/run -H "$H" -H "$J" -d '{"args":{}}'   # name, up to 5 addresses, blurb ≤ 300 chars
```

Expect: the saved summary appears under the action after a reload with what it covers; the Markdown and the PDF contain the saved text; the share bundle holds only the workspace's name, addresses, and blurb. On a fresh workspace with **no** summary: the export route is `409 no_summary` and no file is offered; export buttons are not suggested.

### V4: open tabs and searches in Chrome (US4; FR-027 to FR-030)

In Home, expand the card; click a suggested **Open searches** or **Open related pages** button. Expect: up to 5 new background tabs, none of your existing tabs touched, the run shows "opened N"; with "place in workspace" the tabs end up in this workspace; an address that is not `https` is listed as skipped. Reload Home during a run and confirm no tab opens a second time. With Chrome's extension unavailable (server-only `curl` run of `open_related_tabs`), the run stays "running" and ends **failed** (`browser_failed`) after 120 seconds; nothing is claimed as opened.

### V5: save into the workspace (US5)

`append_plan_items` adds to the checklist the "next steps" agent uses (ticked items kept, no duplicates); `save_refs` refuses a quote that is not in the tab's material; `list_workspace_tabs` and `read_public_pages` show only this workspace's tabs and follow 010's safe-reading rules (a private address or a login page gets an honest note).

### V6: team tools (US6; SC-006, SC-007) *(needs a connection)*

With no `GITHUB_REPO`/`MCP_GITHUB_*` set: no GitHub button is ever suggested; a forced `POST …/actions/github_create_issue/run` is `409 not_connected` ("Connect GitHub to use this action.") and nothing else changes. With a test repository configured (use a throwaway repo, never a real one): a suggested **Create an issue** click creates exactly one issue whose title and body match the preview, and the run shows its number and URL as text; a search click changes nothing. Repeat per service you have. `ACTIONS_LIVE_<NAME>=1` first, to see which bindings resolve.

### V7: Google is the owner's alone; email needs confirmation; mail never reaches the AI (US7; SC-009, SC-014, SC-015) *(needs Google)*

Set `INTEGRATION_OWNER_USER_ID` to your user id and the Google variables. As the owner: **Draft an email** makes one draft and sends nothing; **Send** ends with a prepared message (`email_preview`, state `unsent`) and **no email**; `POST …/runs/$RUN/confirm` `{"to":"you@example.com"}` sends the stored subject and body once (a second confirm is `409 already_sent`; after 30 minutes `409 expired`); **Cancel** sends nothing. **Search mail** returns up to 5 messages in that one response only; reload: the run says "3 messages were shown" and nothing else. As any other person (`T2`): no Drive or Gmail button appears and a forced call is `403 not_available`, whether or not Google is connected.

### V8: boundaries and secrets (US8; SC-010 to SC-012)

Two people, two workspaces, distinctive content: no suggestion, run, or result of one contains the other's. `POST …/workspaces/other/actions/suggest` is `400 not_a_workspace`. Scan the server's console and every run row for your service tokens, a tab's page text, and a mail excerpt: none appear. The automated `actions-safety` suite runs the hijack styles (at least five) through hostile helper output and checks the action did nothing the click did not ask for.

### V9: the Home card (FR-044 to FR-047)

Expand a card: a short, labelled group of suggested actions next to the agents, each with its reason, its state, and its result under it; failing to reach the server keeps what is shown and adds one plain note; the 010 agents work with the suggestion request failing (turn the AI key off) and with no tool configured. With everything configured the five 010 agents still pass their checks (SC-013).

## Mutation checks (do once, then revert)

Weaken each and confirm a test fails: the helper allowlist (add a writer), the owner check (allow anyone), the confirm state guard (allow a second send), the mail-to-prompt type guard (pass a string), the log/secret scan (add a `console.log` of an argument), the prefilled-lock merge (let the model override), the `https` filter on opened addresses.
