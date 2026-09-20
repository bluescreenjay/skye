# AI Browser — Feature Checklist

Ordered Spec Kit features. **MVP cut line: 001–011** (includes **005b**). Do not start P1/stretch (including **010b** MCP tools) until the cut line ships.

Two views (constitution Principle VII): **Home** = all workspaces; **Sidebar** = Chrome Side Panel on the current tab.

How to use: for each feature, run `/speckit-specify` and paste the **Specify prompt** block. Keep prompts focused on *what/why*; put stack detail in `/speckit-plan` (preferred: Gemini, Tiger Data, Vultr). If a preferred vendor fails, plan the original pivot from `tech-stack.txt` (Claude/GPT, Supabase, Vercel/local) and keep types/APIs the same.

**Pivots (if prize stack fails):** Gemini → Claude/GPT · Tiger Data → Supabase Postgres · ElevenLabs → skip or Web Speech · Vultr → Vercel/local · GoDaddy → skip. Do not run two primary databases.

---

## Status

| ID | Feature | Priority | Status |
| --- | --- | --- | --- |
| 001 | Monorepo + shared domain model | P0 | ☑ done |
| 002 | Tab ingestion extension | P0 | ☑ implemented |
| 003 | Workspace persistence API | P0 | ☑ implemented (incl. the ingest endpoint for 002) |
| 004 | AI clustering | P0 | ☑ implemented (server side: the API only; Home trigger is 005b; sidebar UI is 006) |
| 005 | Home — all workspaces | P0 | ☑ implemented (toolbar Home; no new-tab override) |
| 005b | Home → run clustering | P0 | ☑ implemented |
| 006 | Chrome sidebar — in-tab workspace | P0 | ☑ implemented |
| 007 | Manual correction | P0 | ☑ implemented (Home drag/rename + sidebar move/dismiss; Chrome tab groups + create-workspace deferred to stretch 007b) |
| 007b | Chrome tab groups + create workspace | Stretch | ☐ |
| 008 | Workspace AI chat | P0 | ☑ implemented (server side: the chat API; Home card chat wired; sidebar chat panel still a shell from 006) |
| 009 | Plan generation | — | ✂ cut (its checklist is an output of the 010 agents) |
| 010 | Workspace agents | P0 | ☑ implemented (Home card first; the sidebar reuses the list later) |
| 010b | MCP + local action tools | Stretch | ☐ |
| 011 | Global command bar | P0 | ☐ |
| 012 | Saved workspaces + soft suggestions | P1 | ☐ |
| 013 | Desktop workspace voice (ElevenLabs) | P1 | ☐ |
| 014 | Mobile companion | Stretch | ☐ |

---

## P0 — MVP

### 001 — Monorepo + shared domain model

**What:** Scaffold the repo so extension (Home + Sidebar), server, and API share one TypeScript domain model and env layout.

**In scope**
- pnpm workspace: `apps/extension`, `apps/web`, `packages/shared`
- Shared types: `User`, `Workspace`, `TabRef`, `TabEvent`, `PlanItem`, `Message`, `ActionRun`, `Correction`
- Tiger Data (Timescale Postgres) schema: relational tables + `tab_events` hypertable
- Every durable entity includes `user_id`
- Root scripts / env example for Tiger, Gemini, later ElevenLabs (no secrets committed)

**Out of scope:** UI, clustering, chat, real extension behavior

**Depends on:** nothing  
**Unblocks:** 002–011

**Done when:** Shared package builds; Tiger schema file exists; extension and web can import shared types.

**Specify prompt**
```text
Set up the AI Browser monorepo foundation: pnpm workspaces with apps/extension, apps/web, and packages/shared. Define shared TypeScript types for User, Workspace, TabRef, TabEvent, PlanItem, Message, ActionRun, and Correction. Every durable type is user-scoped. Add a Tiger Data (Timescale Postgres) schema skeleton: ordinary workspace tables plus a tab_events hypertable for tab lifecycle over time. Env examples for Tiger and Gemini. No product UI or AI behavior yet—only the shared foundation other features will build on. The product will have two views later (Home for all workspaces, Chrome sidebar on a tab); types must support both. Closing the browser must not imply data loss once persistence lands later; model workspaces as durable entities from day one.
```

---

### 002 — Tab ingestion extension

**What:** Chrome MV3 extension reads open tabs and pushes tab signals to the backend.

**In scope**
- List open tabs (URL, title)
- Capture a short page snippet/content where permitted
- Listen for tab create/update/remove/activate (including which tab is active — sidebar will need this)
- Authenticated (or device-token) POST of tab snapshots to the API (becomes TabRef + TabEvent)
- Background/service worker lifecycle that keeps syncing while Chrome is open

**Out of scope:** Clustering, moving tabs, Home/Sidebar UI (stubs OK)

**Depends on:** 001 (types + API target)  
**Unblocks:** 003, 004, 006, 007

**Done when:** Opening/changing tabs results in server-visible tab records and time-series events within a few seconds.

**Specify prompt**
```text
Build the Chrome MV3 tab ingestion extension for AI Browser. The extension must list open tabs (URL, title), capture a short page snippet when possible, listen for tab lifecycle and active-tab changes, and continuously push tab snapshots to the workspace backend. Each change is an event in time, not only the latest tab list. It observes the browser only—it does not decide workspaces or run AI. Focus on reliable ingestion and sync, not clustering or the Home/Sidebar UIs.
```

---

### 003 — Workspace persistence API

**What:** Server APIs so workspaces and tab membership survive sessions, scoped per user.

**In scope**
- CRUD for workspaces (create, rename, list, archive/delete as needed), always filtered by user_id
- Assign tabs to a workspace or to **Other** (`workspace_id` null)
- Resolve “workspace for this tab/URL” for the sidebar
- Persist tab_events into the Tiger hypertable
- Persist across browser restart / new session
- Device pairing token so Home, Sidebar, and server share one user context

**Out of scope:** AI naming/clustering, rich UI, chat

**Depends on:** 001  
**Unblocks:** 004–011

**Done when:** Create a workspace, assign tabs, restart clients, and the same structure reloads for that user only. Sidebar can ask “which workspace is this tab in?”

**Specify prompt**
```text
Build the workspace persistence API for AI Browser on Tiger Data. Users need durable, user-scoped workspaces that survive closing tabs and the browser. Support creating/listing/renaming/archiving workspaces, assigning tab refs to a workspace or to an Other bucket, resolving the workspace for an active tab, and appending tab lifecycle rows to a tab_events hypertable. Home (directory) and the Chrome sidebar share this API via a device pairing token. No AI clustering yet—manual and API-driven assignment is enough. The Chrome extension (feature 002) already sends batched tab snapshots and events to POST /api/ingest/tabs with a bearer device token; implement that contract (specs/002-tab-ingestion-extension/contracts/ingest-api.md): authenticate by the token and derive the user from it, match each reported tab to an existing tab ref by user and address, refresh the stored browser tab id from every snapshot and clear it for tabs missing from a full snapshot, and count each event once by its event id.
```

---

### 004 — AI clustering

**What:** Automatically group related open tabs into named workspaces using Gemini.

**In scope**
- Cluster from title + URL + snippet via Gemini (no vector DB required)
- Propose workspace names/emoji
- High confidence: create/assign workspaces
- Low confidence: return suggestions for user confirm (do not silently force)
- Respect existing workspaces and Other

**Out of scope:** Embeddings, learning from corrections (store hooks OK), Home/Sidebar chrome (Home trigger is 005b; Side Panel is 006)

**Depends on:** 002, 003  
**Unblocks:** 005b, 006, 010, 011

**Done when:** A messy tab set produces sensible named workspaces (or clear suggestions) without user labeling each tab.

**Specify prompt**
```text
Add AI clustering that turns a messy set of open tabs into named workspaces. Use title, URL, and page snippet with the Gemini API—no vector database for MVP. High-confidence groups may be applied; low-confidence groups must become suggestions the user can accept or ignore. Never treat AI assignment as irreversible. Preserve an Other bucket for unrelated tabs. Clustering decisions live on the server; the extension only supplies tab signals and later applies assignments. Results will appear on Home (all workspaces) and in the sidebar (this tab’s workspace).
```

---

### 005 — Home — all workspaces

**What:** The landing directory: every workspace plus Other, not the in-page workspace.

**In scope**
- Extension page opened from the **toolbar icon** (full Home, not a popup)
- Layout matches the Home view of the checked-in mock (rail + photo + cards); not Tailwind
- Named workspaces as cards and rail tiles; Other as rail-top icons only (not a named “other” card)
- Expand one card on Home for tabs + stub actions/ask/artifacts; click a tab opens its URL in a new browser tab
- Rename and drag membership persist through the 003 API; real data only (empty chrome if unpaired)
- Greeting with local time + weather (location when allowed)

**Out of scope:** Chrome Side Panel (006), `chrome_url_overrides` / new-tab takeover, create-workspace control (007), triggering clustering (005b), live chat and agents (008, 010), ⌘K (011), dummy seed workspaces

**Depends on:** 003 (004 preferred for demo data)  
**Unblocks:** 005b, 007, 011

**Done when:** Toolbar opens Home; a normal new tab stays Chrome’s default; the person sees all workspaces/Other in the mock layout without visiting a random web page.

**Specify prompt**
```text
Build the AI Browser Home view: the directory of all workspaces plus an Other bucket. Open Home from the extension toolbar only—do not take over Chrome’s new-tab page. Layout must match the Home view of the provided HTML mock (home-design-prototype): photo, left icon rail, wordmark, url field, greeting, stacked workspace cards. Other is rail-top icons, never a fake named card. Expand a card on Home to peek at tabs (actions/ask/artifacts can be stubs). Clicking a tab opens that URL in a new browser tab; Home stays. Rename and drag persist via the 003 API. No Side Panel, no create-workspace control, no dummy furniture seed data. Chat, live plans, and real actions can be stubbed.
```

---

### 005b — Home → run clustering

**What:** From Home, trigger the existing 004 clustering API so Other tabs become named workspace cards without curling by hand.

**In scope**
- One clear control on Home (e.g. “organize” / “cluster tabs”) that `POST`s `/api/cluster/runs` with the same Bearer token as ingest/Home
- After a successful run, reload workspaces + tab-refs so cards and the Other rail update
- Quiet loading / error / empty states (misconfigured Gemini, 401, in-progress run) without changing the mock’s Home structure more than necessary for that control
- Optional: surface pending 004 suggestions count or a simple accept/ignore path later in 007; MVP of 005b may only apply high-confidence groups via the existing server behavior

**Out of scope:** Reimplementing Gemini/clustering logic in the extension; ⌘K (011); Side Panel (006); create-workspace UI (007); soft continuous suggestions (012)

**Depends on:** 004, 005  
**Unblocks:** demoable named workspaces on Home; makes 006/011 less dependent on curl

**Done when:** With ingested tabs in Other, the person clicks organize on Home, waits for the run, and sees named workspace cards (or clear failure copy) without leaving Home or using curl.

**Specify prompt**
```text
Add a thin Home trigger for AI Browser clustering. Home already lists workspaces and Other from the 003 API (feature 005). Clustering already runs on the server via POST /api/cluster/runs (feature 004). Wire a single organize control on Home that calls that endpoint with the device Bearer token, then refreshes the directory so named workspace cards appear. Do not move clustering logic into the extension. Do not build the Side Panel, ⌘K, create-workspace, or a full suggestions UI—high-confidence apply from 004 is enough; low-confidence suggestions can stay server-side until 007. Keep the mock Home layout; only add the minimum chrome needed to start a run and show loading or failure.
```

---

### 006 — Chrome sidebar — in-tab workspace

**What:** While the user is on a web page, the workspace for that tab opens in the Chrome Side Panel.

**In scope**
- Chrome Side Panel bound to the active tab
- Show the workspace that tab belongs to (or Other), related tabs, and shells for agents and chat
- Switching tabs retargets the sidebar to that tab’s workspace
- Stay on the page; do not force navigation to Home
- Opening/closing the sidebar does not destroy workspace data

**Out of scope:** Full chat and agent execution (008 and 010 can fill the shells), Home directory (005), ⌘K (011)

**Depends on:** 002, 003 (004–005 preferred; 005b preferred so Home already has named workspaces)  
**Unblocks:** 008–010

**Done when:** Opening a clustered tab shows the right workspace in the sidebar next to the page.

**Specify prompt**
```text
Build the in-tab workspace as a Chrome Side Panel. When the user is on a web page, the sidebar shows the workspace that tab belongs to (or Other), its related tabs, and placeholder areas for plan, suggested actions, and chat. Switching tabs must update the sidebar to the newly active tab’s workspace. The user stays on the page—the workspace comes to them. Home remains the all-workspaces directory; the sidebar must not replace it. Chat replies, live plans, and real actions can be stubbed until later features.
```

---

### 007 — Manual correction

**What:** Users fix AI mistakes; corrections persist on the server.

**In scope**
- On **Home**: drag tabs between workspaces and to/from Other; rename workspaces
- In **Sidebar**: move or recategorize the active tab (and dismiss “add to workspace” suggestions)
- Persist corrections; override prior AI assignment
- Record correction events for future learning signals

**Out of scope / deferred:** Training a custom model from corrections; **Chrome tab-group sync** and **create-workspace on Home** (stretch **007b**)

**Depends on:** 002, 003, 005, 006  
**Unblocks:** trust for demo; improves 004 over time

**Done when:** User can reorganize on Home (and move this tab from the sidebar) and membership sticks after reload.

**Specify prompt**
```text
Add manual workspace correction across both views. On Home, users drag tabs between workspaces and Other, create workspaces, and rename them. In the Chrome sidebar, they can move or recategorize the active tab without leaving the page. Manual moves always win over prior AI clustering. Persist corrections as feedback signals. Sync assignments back through the Chrome extension so the browser’s tab organization matches the workspace model. Do not build ML retraining—just capture and honor corrections.
```

---

### 008 — Workspace AI chat

**What:** Per-workspace assistant (Gemini) in the sidebar, already knowing that workspace.

**In scope**
- Chat lives primarily in the **Sidebar**, scoped to the active tab’s workspace
- Context from tab titles/URLs/snippets (+ plan/notes when present)
- Support questions like: what have I found, summarize, what’s left, what did we decide
- Persist message history on the workspace (visible if the same workspace is opened later)

**Out of scope:** Global browser commands (011), multi-workspace agents, voice (013)

**Depends on:** 003, 006  
**Unblocks:** 010

**Done when:** User asks in the sidebar about this tab’s workspace and gets answers that reference its tabs without re-explaining.

**Specify prompt**
```text
Add per-workspace AI chat powered by the Gemini API, in the Chrome sidebar. Each workspace is its own context boundary: the model should use that workspace’s tabs (titles, URLs, snippets) and any plan/notes so the user never re-explains what they’re working on while they stay on the page. Persist conversation history on the workspace. Support questions like summarize findings, what’s missing, what we decided, and what to do next. This is workspace chat only—not the global command bar, not voice, and not a second chat box that only exists on Home.
```

---

### 009 — Plan generation (cut)

**Cut.** A separate plan checklist overlapped with the workspace agents (010). Its useful piece, a short tickable checklist, is now the output of one 010 agent ("next steps"), saved in the existing plan items so chat can see it. The number is kept so existing spec folders do not move.

---

### 010 — Workspace agents

**What:** A fixed list of workspace "agents" on each expanded Home card. Each agent is a one-shot tool: it reads the workspace's context (and, where allowed, the pages of its tabs) and produces a real, saved result shown right under the agent. This replaces the earlier plan checklist (009) and the actions and artifacts stubs on the Home card.

**In scope** (pick ~5 that demo well)
- The agent list in the expanded Home card, laid out as tabs | chat | agents (it replaces the action buttons and the artifacts column from 005)
- Each agent row: name, one-line description, a run control, its status, and its latest result inline; older runs can be expanded
- Starter set: summarize sources, compare options, what's missing, next steps (a tickable checklist saved as plan items, so chat sees it), collect refs (key quotes with their links)
- A server-side "read the page" step that fetches the public https pages of the workspace's tabs, for richer text than the stored excerpt. It must be safe by design: no private or local addresses, size and time limits, and fetched text treated as untrusted data
- Store every run (input, output, status) as an action run on the workspace
- A fixed catalog only: "agent" is the interface word for a one-shot tool, not an autonomous program

**Out of scope:** user-defined or custom agents, multi-step or autonomous agents, MCP and external SaaS tools (those are **010b**), computer-use, login-walled pages and PDFs, calendar integrations, a separate plan feature (009 is cut), and sidebar placement (006 reuses the component later)

**Depends on:** 005, 008 (uses the shared AI layer and the workspace context from chat)  
**Unblocks:** 011 (the command bar can run agents), the sidebar agent list (006), **010b**

**Done when:** Clicking an agent on an expanded Home card produces a visible real result under it that is still there after a reload, and ticks on the "next steps" checklist persist and show up in chat answers.

**Specify prompt**
```text
Add a fixed list of workspace agents to each expanded card on Home, laid out as tabs | chat | agents (replacing the current action buttons and artifacts column). Each agent is a one-shot tool, not an autonomous program: it runs against the workspace's context and saves a real result that appears right under the agent, with older runs available to expand. Include roughly five reliable agents: summarize sources, compare options, what's missing, next steps (a checklist the user can tick, saved so the workspace chat can see it), and collect refs (key quotes with links). Agents may read the actual pages of the workspace's public https tabs on the server for richer text than the stored excerpt; this must be safe (no private or local addresses, size and time limits) and fetched page text must be treated as untrusted data, never instructions. The provider is configurable behind one interface (VT ARC by default, Gemini as backup) and every model call is triggered only by the user pressing an agent. No custom or multi-step agents, no MCP (that is stretch feature 010b), no computer-use. It must be fully testable without any UI, like features 003, 004, and 008; the sidebar will reuse the same list later.
```

---

### 010b — MCP + local action tools (stretch)

**Stretch** — full entry lives under [Stretch → 010b](#010b--mcp--local-action-tools) below. Depends on 010; does not gate the MVP cut line. Full tool catalog on the server; UI shows a **dynamic, agent-picked** subset as action buttons (not every tool all the time). After 010b ships, ⌘K (011) MAY optionally route confirmed tool intents into that catalog; **011 MVP must not depend on 010b**.

---

### 011 — Global command bar

**What:** Natural-language control for browser/workspace operations (⌘K), Gemini-routed. An **intent router** — not a second chat product and not an unconstrained agent.

**In scope**
- Available from **Home** and while browsing (extension command overlay / sidebar)
- Browser/workspace commands such as: organize my tabs, put X together, create a workspace for these, clean up, show Home / active workspaces
- “What was I working on yesterday?” using Tiger continuous aggregates over tab_events
- Routes intents to clustering, persistence, navigation, and the **fixed 010 workspace-agent catalog** (e.g. “summarize this workspace”, “next steps for Hackathon”) via the same agent/run APIs as the Home card — not a parallel agent system
- Routes intents only; does not invent custom multi-step agents

**Out of scope:** Arbitrary web automation, shopping checkout, voice (013); **010b** MCP / SaaS tools and silent tool loops (those may plug into ⌘K later as optional stretch — see 010b)

**Depends on:** 004, 005, 005b, 006, 007, **010**  
**Unblocks:** MVP complete

**Done when:** User can trigger organize/create/cleanup via natural language and see Home and the sidebar update, and can run at least one 010 agent (e.g. summarize) for the current or named workspace from ⌘K with the result saved like a Home agent run.

**Specify prompt**
```text
Add a global AI command bar (⌘K) as the natural-language control layer for AI Browser, powered by Gemini. It should work from Home and while a web page is open (extension overlay and/or sidebar). Users should be able to say things like organize my tabs, put related shopping/travel tabs together, create a workspace for these tabs, clean up my browser, show my workspaces, or what was I working on yesterday (using stored tab activity over time). Feature 005b already offers a one-click organize on Home via POST /api/cluster/runs; the command bar generalizes that and other intents. It MUST also route workspace-agent intents to the fixed 010 catalog (summarize, compare, what's missing, next steps, collect refs) using the same server agent/run paths as the Home card—not a second agent stack. It is not a separate unconstrained agent. MCP / 010b SaaS tools are out of scope for this feature (optional later). Voice input is a later feature.
```

---

## P1 — Strong demo (after MVP)

### 012 — Saved workspaces + soft suggestions

**What:** Explicit save/archive and gentler continuous organization.

**In scope**
- Save important workspaces; reopen with full memory when no tabs are open (from Home)
- Soft prompts in the sidebar: “These 3 tabs seem related to Hackathon — Add / Ignore”
- Light workspace history (key events)

**Out of scope:** Mobile/voice

**Depends on:** 001–011  
**Specify prompt**
```text
Add saved workspaces and soft organization suggestions. Users can save/archive workspaces from Home and return later with memory intact even when no tabs are open. When confidence is medium, the sidebar can prompt to add the current tab (or a small set) to an existing workspace instead of silently moving them. Include a lightweight history of important workspace events.
```

---

### 013 — Desktop workspace voice (ElevenLabs)

**What:** Give the sidebar workspace a spoken voice on desktop—no mobile app required.

**In scope**
- ElevenLabs TTS for sidebar chat replies and/or command-bar answers
- Optional STT into chat or ⌘K if time
- Same workspace state as text UI (voice is another interface, not another product)

**Out of scope:** Full mobile app, computer-use agents, replacing text UI

**Depends on:** 008, 011  
**Specify prompt**
```text
Add desktop workspace voice using ElevenLabs in the Chrome sidebar. Users should be able to hear workspace chat (and optionally command-bar) replies as natural speech while they stay on the page. Voice operates on the same workspace context as text—it does not create a separate agent or require a mobile app. Optional: speech-to-text into chat or the command bar. Text remains the source of truth; voice is an interface.
```

---

### 010b — MCP + local action tools

**What:** Real executable tools behind workspace agents and (later) chat/command bar: a small MCP client for GitHub, Notion, Slack, Jira, Google Drive, and Gmail, plus first-party local/browser tools that need no third-party account. VT ARC (or Gemini) stays the LLM; this feature adds the tool layer, not a new model vendor. The full catalog lives on the server; the UI does **not** dump every tool as a permanent button. A suggestion agent reads workspace context (tabs, summary, plan, credentials available) and proposes a small set of the best next actions; the product **dynamically renders buttons** for those suggestions (label, tool id, prefilled args). The user still confirms by clicking—tools do not run silently.

**Priority:** Stretch — start only after **010** ships. Does not gate the MVP cut line.

**Tool catalog** (implement all on the server; the UI surfaces a context-picked subset)

*Local / first-party (no MCP; server + extension)*

| Tool id | What it does |
| --- | --- |
| `list_workspace_tabs` | Return the workspace’s saved tabs (title, URL, snippet) as structured data for other tools |
| `read_public_pages` | Fetch allowed public https pages for richer text (reuse 010’s safe fetch rules) |
| `write_summary` | Save a workspace summary artifact (markdown) on the workspace; show under the agent run |
| `export_summary_markdown` | Download / offer the latest summary as a `.md` file |
| `export_summary_pdf` | Generate a simple PDF of the latest summary and offer it for download |
| `open_related_tabs` | Extension opens N suggested https URLs as new Chrome tabs (optionally assign into this workspace) |
| `open_google_searches` | Build Google search URLs from queries and open them as new tabs |
| `save_search_queries` | Persist suggested queries on the workspace so chat/agents can reuse them |
| `append_plan_items` | Add checklist items to the workspace plan (same store as 010 “next steps”) |
| `save_refs` | Persist quote + URL refs on the workspace (same idea as 010 collect refs) |
| `copy_text` | Return text for the UI to copy to the clipboard (summaries, links, issue bodies) |
| `compose_share_link` | Build a shareable deep link or plain-text bundle (workspace name + key URLs + summary blurb) for pasting elsewhere |

*MCP-backed SaaS (real MCP client on the server)*

| Integration | Tool ids (minimum) | Notes |
| --- | --- | --- |
| **GitHub** | `github_create_issue`, `github_create_gist`, `github_search_code_or_issues`, `github_comment_on_issue` | PAT or GitHub App; default to a configured demo repo |
| **Notion** | `notion_create_page`, `notion_append_blocks`, `notion_search` | OAuth or internal integration token; page under a configured parent |
| **Slack** | `slack_post_message`, `slack_upload_snippet` | Bot token; post to a configured channel (or channel arg if allowed) |
| **Jira** | `jira_create_issue`, `jira_search`, `jira_add_comment` | Site URL + API token; project key configurable |
| **Google Drive** | `drive_upload_markdown`, `drive_create_doc_from_summary`, `drive_get_share_link` | OAuth; upload summary/PDF or create a Doc from workspace summary |
| **Gmail** | `gmail_create_draft`, `gmail_send_message`, `gmail_search_messages` | OAuth; act only on the person's own mailbox. Default suggestion is a **draft**; sending shows the exact recipient, subject, and body and needs a separate confirm. Search returns sender, subject, date, and a short excerpt only |

**In scope**
- A server-side tool registry: each tool has id, description, JSON input schema, executor, and whether it is `local` or `mcp:<server>`
- An MCP client module that connects to the six configured servers (stdio and/or HTTP/SSE as each server requires), lists tools, maps them into OpenAI-compatible `tools` for VT ARC / Gemini, executes `tool_calls`, and records results on `ActionRun`
- **Dynamic action suggestions:** a user-triggered (or workspace-open / refresh) suggestion pass where the model sees the registry (ids + short descriptions + which integrations are connected) and workspace context, then returns a small ranked list of suggested actions (e.g. 3–6). Each suggestion has a human label, tool id, optional prefilled args, and short rationale. Home (and later sidebar) **renders only those as buttons**—not the full catalog. Suggestions refresh when workspace context changes materially or the user asks to refresh; omit tools whose credentials are missing
- Clicking a suggested button runs that tool (or a short bounded tool loop, small max turns) and stores an `ActionRun`; the UI may refresh suggestions after a successful run
- Credential wiring via env / per-user secrets for the six SaaS integrations; missing credentials → tool excluded from suggestions (and a clear “connect X” if the user somehow invokes it), not a crash
- Local tools that the extension must perform (`open_related_tabs`, `open_google_searches`, downloads): server returns an action intent; extension executes and reports success/failure
- Home (and later sidebar) shows external URL/id in the run result for SaaS writes (e.g. Notion page, GitHub issue)
- Fake/stub MCP, suggestion, and local executors in tests so CI never needs live GitHub/Notion/etc.
- Implement **every** tool in the catalog above on the server (local table + MCP minimum set); dynamic UI is how they are *presented*, not how many are *built*

**Out of scope:** showing the entire tool catalog as a permanent button grid; computer-use / mouse agents; arbitrary user-added MCP servers in the UI; Pinterest, Spotify, Figma, Miro (Gmail was moved into scope); filesystem MCP on a remote host; replacing VT ARC; unbounded autonomous agents that run tools without a click; making MCP required for 010’s five one-shot agents

**Depends on:** 010 (agent UI + ActionRun + safe page fetch), 008 (shared LLM), 002/003 (tabs + persistence); extension hooks for open-tab / download intents  
**Unblocks:** richer demo actions on Home/sidebar; optional ⌘K (011) shortcuts into the same tool registry **after** both 010b and 011 exist — does not change 011’s MVP depends (010 only)

**Done when:** On an expanded Home card, the product shows a short, context-specific set of action buttons (not the full catalog). Those buttons can (1) write/export a summary (md + PDF), (2) open related tabs and Google searches in Chrome, and (3) with credentials configured, push or create something real in each of GitHub, Notion, Slack, Jira, Drive, and Gmail (a draft; a send only after the person confirms the exact message) when suggested—each run saved and visible after reload. Changing workspace context (or refresh) changes which buttons appear. All catalog tools exist behind the registry and are covered by fake-executor tests.

**Specify prompt**
```text
Add stretch feature 010b: real action tools on top of workspace agents, without replacing the LLM provider (VT ARC default, Gemini backup).

Build a server-side tool registry and MCP client with the full catalog below. The UI must NOT show every tool all the time. A suggestion agent (user-triggered or on workspace open/refresh) reads workspace context plus which integrations are connected, picks a small ranked set of best next actions (about 3–6), and the product dynamically creates buttons for only those (label, tool id, optional prefilled args, short rationale). Tools run only when the user clicks a button. After a run, suggestions may refresh. Omit tools that need missing credentials.

Local / first-party tools (no third-party account): list_workspace_tabs, read_public_pages (reuse 010 safe fetch), write_summary, export_summary_markdown, export_summary_pdf, open_related_tabs, open_google_searches, save_search_queries, append_plan_items, save_refs, copy_text, compose_share_link. Tab-opening and file download that must happen in Chrome are returned as intents for the extension to execute.

MCP-backed tools for six integrations — implement at least: GitHub (create_issue, create_gist, search, comment_on_issue); Notion (create_page, append_blocks, search); Slack (post_message, upload_snippet); Jira (create_issue, search, add_comment); Google Drive (upload_markdown, create_doc_from_summary, get_share_link); Gmail (create_draft, send_message, search_messages — sending needs a separate confirm of the exact message). Credentials from env or per-user secrets; missing auth fails clearly and keeps those tools out of suggestions.

Bounded tool loop on click (small max turns). Do not require MCP for the original 010 one-shot agents. No computer-use, no always-on full catalog UI, no arbitrary user-installed MCP servers, no swap of VT ARC, no silent tool execution without a click. Fully testable with fake MCP/suggestion/local executors. Home shows external result links/ids on successful SaaS tools.
```

---

### 014 — Mobile companion

**What:** Phone as a remote interface to the same workspaces (Home-like list + chat), via a **mobile web app** paired with a short-lived QR/code. Light ElevenLabs voice on chat is a soft add-on.

**In scope**
- Separate mobile web companion (phone browser / add-to-home-screen)—not a native store app and not a Side Panel clone
- Pair phone to the same person as desktop: desktop shows short-lived QR + one-time code → mobile redeems → durable per-device credential; revoke from desktop
- Mobile client listing workspaces + chat/plan/agents against the same workspace state as desktop
- Soft: hear chat replies (and optionally speak a question) via ElevenLabs-style voice; text remains source of truth; voice must not block pair/list/typed chat

**Out of scope:** Recreating Chrome or the Side Panel on mobile; controlling desktop tabs from the phone; full OAuth/email login (pairing is enough for this feature); voice-only product or replacing text UI

**Depends on:** 001–011 (012–013 helpful)  
**Specify prompt**
```text
Add a mobile companion as a separate mobile web app that is a remote interface to the same persistent workspaces—not a second browser and not a Side Panel clone. Pair the phone to the desktop person via a short-lived QR code or one-time code shown on desktop; redeeming it issues a durable per-device credential for the same person. Users can list workspaces (Home-like), ask questions, review plans and agent results, and trigger actions. Lightly include ElevenLabs voice for hearing chat replies and optional speak-to-ask on mobile—text stays the source of truth and voice must not block pairing or typed chat. Desktop Home, desktop sidebar, and mobile must share the same workspace state.
```

---

## Dependency sketch

```text
001 foundation
 ├─ 002 extension ingest
 ├─ 003 persistence API
 │   ├─ 004 clustering (server API)
 │   ├─ 005 Home (all workspaces)
 │   │   └─ 005b Home → run clustering (calls 004)
 │   │       └─ 007 correction (Home drag + sidebar move-this-tab)
 │   └─ 006 Sidebar (in-tab workspace)
 │       ├─ 008 chat ─ 010 agents (Home card first; 009 plan cut, folded into 010)
 │       │              ├─ 010b MCP + local tools (stretch; after 010; optional ⌘K later)
 │       │              └─ 011 command bar (Home + browsing; generalizes 005b + runs 010 agents)
 │       └─ (011 also depends on 004–007 for organize / navigate intents)
 └─ (after MVP) 012 → 013 ElevenLabs → 014 mobile
```

## References

- Product: `initialspec.txt`
- Stack: `tech-stack.txt`
- Governance: `.specify/memory/constitution.md`
- Constitution paste prompt: `constitution-prompt.txt`
