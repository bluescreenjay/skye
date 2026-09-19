# AI Browser — Feature Checklist

Ordered Spec Kit features. **MVP cut line: 001–011.** Do not start P1/stretch until the cut line ships.

Two views (constitution Principle VII): **Home** = all workspaces; **Sidebar** = Chrome Side Panel on the current tab.

How to use: for each feature, run `/speckit-specify` and paste the **Specify prompt** block. Keep prompts focused on *what/why*; put stack detail in `/speckit-plan` (preferred: Gemini, Tiger Data, Vultr). If a preferred vendor fails, plan the original pivot from `tech-stack.txt` (Claude/GPT, Supabase, Vercel/local) and keep types/APIs the same.

**Pivots (if prize stack fails):** Gemini → Claude/GPT · Tiger Data → Supabase Postgres · ElevenLabs → skip or Web Speech · Vultr → Vercel/local · GoDaddy → skip. Do not run two primary databases.

---

## Status

| ID | Feature | Priority | Status |
| --- | --- | --- | --- |
| 001 | Monorepo + shared domain model | P0 | ☑ spec |
| 002 | Tab ingestion extension | P0 | ☐ |
| 003 | Workspace persistence API | P0 | ☐ |
| 004 | AI clustering | P0 | ☐ |
| 005 | Home — all workspaces | P0 | ☐ |
| 006 | Chrome sidebar — in-tab workspace | P0 | ☐ |
| 007 | Manual correction | P0 | ☐ |
| 008 | Workspace AI chat | P0 | ☐ |
| 009 | Plan generation | P0 | ☐ |
| 010 | Contextual actions | P0 | ☐ |
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
Build the workspace persistence API for AI Browser on Tiger Data. Users need durable, user-scoped workspaces that survive closing tabs and the browser. Support creating/listing/renaming/archiving workspaces, assigning tab refs to a workspace or to an Other bucket, resolving the workspace for an active tab, and appending tab lifecycle rows to a tab_events hypertable. Home (directory) and the Chrome sidebar share this API via a device pairing token. No AI clustering yet—manual and API-driven assignment is enough.
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

**Out of scope:** Embeddings, learning from corrections (store hooks OK), Home/Sidebar chrome

**Depends on:** 002, 003  
**Unblocks:** 005, 006, 009, 011

**Done when:** A messy tab set produces sensible named workspaces (or clear suggestions) without user labeling each tab.

**Specify prompt**
```text
Add AI clustering that turns a messy set of open tabs into named workspaces. Use title, URL, and page snippet with the Gemini API—no vector database for MVP. High-confidence groups may be applied; low-confidence groups must become suggestions the user can accept or ignore. Never treat AI assignment as irreversible. Preserve an Other bucket for unrelated tabs. Clustering decisions live on the server; the extension only supplies tab signals and later applies assignments. Results will appear on Home (all workspaces) and in the sidebar (this tab’s workspace).
```

---

### 005 — Home — all workspaces

**What:** The landing directory: every workspace plus Other, not the in-page workspace.

**In scope**
- Chrome new-tab / extension Home page
- List all workspaces (name, emoji, tab count) and the Other bucket
- Open a workspace overview from Home (member tabs; plan/actions/chat can be stubs)
- Empty and loading states
- Feels like a map of your work, not a bookmark manager

**Out of scope:** Chrome Side Panel (006), live chat/plan/actions (008–010), ⌘K (011)

**Depends on:** 003 (004 preferred for demo data)  
**Unblocks:** 007, 011

**Done when:** User can open Home and see all workspaces/Other without visiting a random web page.

**Specify prompt**
```text
Build the AI Browser Home view: the directory of all workspaces plus an Other bucket. Home is the landing page (Chrome new-tab / extension home), not a page you only reach after opening an article. Users should see every workspace at a glance, open a workspace to see its tabs, and understand the layout of their work. This is the forest view. Do not build the Chrome sidebar here—that is the in-tab workspace. Chat, live plans, and real actions can be stubbed.
```

---

### 006 — Chrome sidebar — in-tab workspace

**What:** While the user is on a web page, the workspace for that tab opens in the Chrome Side Panel.

**In scope**
- Chrome Side Panel bound to the active tab
- Show the workspace that tab belongs to (or Other), related tabs, and shells for plan, actions, and chat
- Switching tabs retargets the sidebar to that tab’s workspace
- Stay on the page; do not force navigation to Home
- Opening/closing the sidebar does not destroy workspace data

**Out of scope:** Full chat/plan/action execution (008–010 can fill the shells), Home directory (005), ⌘K (011)

**Depends on:** 002, 003 (004–005 preferred)  
**Unblocks:** 008–010

**Done when:** Opening a clustered tab shows the right workspace in the sidebar next to the page.

**Specify prompt**
```text
Build the in-tab workspace as a Chrome Side Panel. When the user is on a web page, the sidebar shows the workspace that tab belongs to (or Other), its related tabs, and placeholder areas for plan, suggested actions, and chat. Switching tabs must update the sidebar to the newly active tab’s workspace. The user stays on the page—the workspace comes to them. Home remains the all-workspaces directory; the sidebar must not replace it. Chat replies, live plans, and real actions can be stubbed until later features.
```

---

### 007 — Manual correction

**What:** Users fix AI mistakes; corrections sync back to Chrome tabs.

**In scope**
- On **Home**: drag tabs between workspaces and to/from Other; create and rename workspaces
- In **Sidebar**: move or recategorize the active tab (and dismiss “add to workspace” suggestions)
- Persist corrections; override prior AI assignment
- Extension applies moves (tab groups or equivalent) so Chrome matches the model
- Record correction events for future learning signals

**Out of scope:** Training a custom model from corrections

**Depends on:** 002, 003, 005, 006  
**Unblocks:** trust for demo; improves 004 over time

**Done when:** User can reorganize on Home (and move this tab from the sidebar) and see Chrome follow.

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
**Unblocks:** 009, 010

**Done when:** User asks in the sidebar about this tab’s workspace and gets answers that reference its tabs without re-explaining.

**Specify prompt**
```text
Add per-workspace AI chat powered by the Gemini API, in the Chrome sidebar. Each workspace is its own context boundary: the model should use that workspace’s tabs (titles, URLs, snippets) and any plan/notes so the user never re-explains what they’re working on while they stay on the page. Persist conversation history on the workspace. Support questions like summarize findings, what’s missing, what we decided, and what to do next. This is workspace chat only—not the global command bar, not voice, and not a second chat box that only exists on Home.
```

---

### 009 — Plan generation

**What:** Lightweight checklist plans in the sidebar, derived from workspace activity (Gemini).

**In scope**
- Generate a short plan/checklist from workspace context
- Show checklist in the **Sidebar**; mark items done/undone
- Home MAY show a compact plan preview; Sidebar is source of interaction
- Update plan via chat (“make me a plan”, “update my plan”)
- Keep plans lightweight—not a full project-management product

**Out of scope:** Assignees, due dates, Gantt, external PM sync

**Depends on:** 006, 008  
**Unblocks:** stronger demo narrative

**Done when:** Opening a tab in a clustered workspace shows a sensible checklist in the sidebar that the user can tick and refresh.

**Specify prompt**
```text
Add lightweight workspace plan generation using Gemini, shown in the Chrome sidebar next to the page. From a workspace’s tabs and activity, the AI creates a short checklist of next steps (not a full project-management system). Users can mark items complete and ask chat to create or update the plan. Home may preview the plan; the sidebar is where you work it. Plans are dynamic and durable with the workspace.
```

---

### 010 — Contextual actions

**What:** Gemini tool-calling actions that run from the sidebar and write results into the workspace.

**In scope** (pick ~3–5 that demo well)
- Summarize workspace sources (strong Gemini prize demo: papers/docs)
- Compare tabs/options
- Create a document from research
- Create tasks (can feed plan items)
- Store action runs (input/output/status) on the workspace
- Trigger from the **Sidebar** while looking at the page

**Out of scope:** MCP marketplace, dynamic action discovery, computer-use, calendar integrations (stretch)

**Depends on:** 008 (006 minimum)  
**Unblocks:** demo “agent” feel without agents

**Done when:** Clicking an action in the sidebar produces a visible real result (not a placeholder toast).

**Specify prompt**
```text
Add a fixed set of contextual workspace actions that actually execute via Gemini tool-calling from the Chrome sidebar. Include roughly three to five reliable actions such as summarize sources (including dense research pages), compare open options/tabs, create a research document, and create tasks/plan items. The user stays on the web page; results land in the workspace and show in the sidebar. Use simple tools against workspace context—no computer-use agents and no MCP requirement. Prefer least-power implementations that work in a live demo.
```

---

### 011 — Global command bar

**What:** Natural-language control for browser/workspace operations (⌘K), Gemini-routed.

**In scope**
- Available from **Home** and while browsing (extension command overlay / sidebar)
- Commands such as: organize my tabs, put X together, create a workspace for these, clean up, show Home / active workspaces
- “What was I working on yesterday?” using Tiger continuous aggregates over tab_events
- Routes intents to clustering, persistence, and navigation—not a second chat product

**Out of scope:** Arbitrary web automation, shopping checkout, voice (013)

**Depends on:** 004, 005, 006, 007  
**Unblocks:** MVP complete

**Done when:** User can trigger organize/create/cleanup via natural language and see Home and the sidebar update.

**Specify prompt**
```text
Add a global AI command bar (⌘K) as the natural-language control layer for AI Browser, powered by Gemini. It should work from Home and while a web page is open (extension overlay and/or sidebar). Users should be able to say things like organize my tabs, put related shopping/travel tabs together, create a workspace for these tabs, clean up my browser, show my workspaces, or what was I working on yesterday (using stored tab activity over time). The command bar orchestrates existing clustering and persistence; it is not a separate unconstrained agent. Voice input is a later feature.
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

## Stretch

### 014 — Mobile companion

**What:** Phone as a remote interface to the same workspaces (Home-like list + chat).

**In scope**
- Mobile client listing workspaces + chat/plan/actions against the same API
- Reuse ElevenLabs voice if 013 already exists

**Out of scope:** Recreating Chrome or the Side Panel on mobile

**Depends on:** 001–011 (012–013 helpful)  
**Specify prompt**
```text
Add a mobile companion that is a remote interface to the same persistent workspaces—not a second browser and not a Side Panel clone. Users can list workspaces (Home-like), ask questions, review plans, and trigger actions. Reuse existing voice if present. Desktop Home, desktop sidebar, and mobile must share the same workspace state.
```

---

## Dependency sketch

```text
001 foundation
 ├─ 002 extension ingest
 ├─ 003 persistence API
 │   ├─ 004 clustering
 │   ├─ 005 Home (all workspaces)
 │   │   └─ 007 correction (Home drag + sidebar move-this-tab)
 │   └─ 006 Sidebar (in-tab workspace)
 │       ├─ 008 chat ─ 009 plan
 │       │         └─ 010 actions
 │       └─ 011 command bar (Home + browsing)
 └─ (after MVP) 012 → 013 ElevenLabs → 014 mobile
```

## References

- Product: `initialspec.txt`
- Stack: `tech-stack.txt`
- Governance: `.specify/memory/constitution.md`
- Constitution paste prompt: `constitution-prompt.txt`
