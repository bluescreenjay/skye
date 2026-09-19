<!--
Sync Impact Report
- Version change: 1.2.0 → 1.3.0
- Modified principles: II renamed/expanded (extension presents Home + Sidebar; server still decides)
- Added principles: VII. Two Surfaces — Home and Sidebar
- Added sections: Two UI Surfaces under Technology Stack
- Removed sections: none
- Feature order: 005 Home, 006 Sidebar; P0 cut line 001–011
- Follow-up TODOs: none
-->
# AI Browser Constitution

## Core Principles

### I. Workspace-First

The fundamental unit of the product is the **workspace**, not the tab.

- Tabs, URLs, and page snippets are inputs that feed a workspace.
- A workspace MUST own persistent memory: tabs refs, AI context, conversation
  history, plan, notes, generated content, and available actions.
- Closing tabs or the browser MUST NOT destroy a workspace.
- Features MUST be designed around workspace continuity, not page chrome.

**Rationale**: The product thesis is "tabs become workspaces; workspaces become
agents." Page-oriented features without workspace persistence violate the core loop.

### II. Extension Observes and Presents; Server Decides

The Chrome extension captures browser state, applies tab organization, and
hosts the two product UIs. The server owns intelligence and storage.

- The extension MUST handle: tab listing, page content/snippet capture, tab
  change events, applying workspace assignments (move/group tabs), the Home
  view, and the Side Panel on web pages.
- The server/app (Next.js + the primary Postgres store) MUST own: clustering,
  workspace CRUD, AI context, plans, chat, and action execution.
- Clients MUST NOT each invent independent clustering or conflicting workspace IDs.
- Long-term Chromium-fork ambitions MUST NOT block the extension + server MVP.

**Rationale**: Spec §26–27, plus the two-view UX: directory at Home, in-tab
workspace in the Chrome sidebar.

### III. User Corrections Win

AI organization MUST remain reversible and subordinate to explicit user control.

- Users MUST be able to drag tabs between workspaces, move tabs to Other,
  create/rename/merge workspaces, and dismiss suggestions.
- Manual corrections MUST override prior AI assignments for those tabs.
- Low-confidence clustering SHOULD suggest ("Add these tabs?") rather than
  silently force moves.
- Corrections SHOULD be retained as feedback signals for future organization.
- Home is the primary place to reorganize across workspaces; the sidebar MAY
  move or recategorize the **active tab**.

**Rationale**: Spec §9–10; irreversible AI grouping destroys trust.

### IV. Least-Power Actions

Prefer the simplest execution mechanism that fulfills an action.

- MVP actions MUST use hard-coded tools and LLM tool-calling against workspace
  context (summarize, compare, create doc, create tasks, etc.).
- Computer-use / mouse-control browser agents are FORBIDDEN in MVP.
- MCP servers and multi-step specialized agents are OPTIONAL stretch only;
  interfaces MAY be stubbed, but MUST NOT gate the demo.
- Dynamic action discovery is a long-term goal, not an MVP requirement.

**Rationale**: Spec §25; least complex path keeps the hackathon demo reliable.

### V. One TypeScript Surface

All product surfaces share one typed domain model.

- Language MUST be TypeScript across extension, web/server, API, and shared packages.
- Canonical types for User, Workspace, TabRef, TabEvent, PlanItem, Message,
  ActionRun, and Correction MUST live in a shared package—no divergent models.
- Home and Sidebar MUST share components and types; they MUST NOT fork
  parallel workspace UIs.
- Monorepo layout SHOULD be `apps/extension`, `apps/web`, `packages/shared`
  (pnpm).

**Rationale**: Reduces integration bugs between Home, Sidebar, and API during a
one-week build.

### VI. Demo-Hard, Architecture-Soft

Ship the core product loop before polish, stretch platforms, or premature
abstraction.

- MVP MUST prove: ingest → cluster → persist → Home directory → Sidebar on a
  tab → correct → chat → plan → actions → global command bar (⌘K).
- Desktop voice (ElevenLabs), saved-workspace polish, and embeddings are P1.
  Mobile companion remains stretch. None of these MAY delay P0.
- Prize-oriented vendors (Gemini, Tiger Data, ElevenLabs, Vultr, GoDaddy) are
  preferred, not load-bearing. If any of them blocks the core loop, pivot to
  the original fallback in the Stack Pivots table in this constitution.
  Pivoting MUST NOT require a product rewrite—only a vendor swap behind the
  same types and APIs.
- Prefer working end-to-end paths over incomplete "platform" layers.

**Rationale**: Spec §29; the MVP question is whether AI can turn messy tabs into
a useful persistent workspace.

### VII. Two Surfaces — Home and Sidebar

The product has exactly two primary desktop views. They show the same
workspaces at different zoom levels.

- **Home** is the directory: all workspaces plus Other. It is the landing
  view (Chrome new-tab / extension home). Users go here to see the forest,
  open a workspace overview, and reorganize tabs across workspaces.
- **Sidebar** is the in-tab workspace: when the user is on a web page, the
  Chrome Side Panel shows that tab's workspace plus plan, actions, chat, and
  related tabs. Users stay on the page; the workspace comes to them.
- Switching tabs MUST retarget the sidebar to the active tab's workspace
  (or Other if unassigned). Closing the sidebar MUST NOT destroy the workspace.
- Home MUST NOT be the only place to use a workspace, and the sidebar MUST NOT
  replace the directory. Both are required for MVP.

**Rationale**: A separate web app as the only workspace UI pulls people out of
browsing. A sidebar with no Home leaves no place to see all work.

## Technology Stack & Platform Constraints

Locked stack for MVP planning and implementation (see `tech-stack.txt`):

| Layer | Preferred (try first) | Pivot (if preferred fails) |
| --- | --- | --- |
| Extension | Chrome MV3 + Vite + CRXJS (or Plasmo); new-tab Home; Side Panel | same |
| Web / API | Next.js (App Router) + React + Tailwind | same |
| Backend | Next.js Route Handlers | same |
| Hosting | Vultr | Vercel / local / any Node host |
| Data | Tiger Data (Timescale Postgres): workspaces + `tab_events` hypertable | Supabase Postgres; `tab_events` as a normal table (aggregates in SQL or app code) |
| Auth | `user_id` + device pairing token in the primary DB | Supabase Auth (still `user_id` on every row) |
| AI | Google Gemini API | Claude or GPT-4.1-class via one SDK |
| Clustering (MVP) | Same LLM on title + URL + snippet | same contract, swapped provider |
| Voice (P1) | ElevenLabs TTS on desktop | Skip voice, or browser `speechSynthesis` / Web Speech API |
| Domain | GoDaddy Registry | Skip; use a Vultr/Vercel URL |
| Mobile | Stretch (Expo against the same API) | same |

**Pivot rule:** Preferred vendors are the default in specs and plans. If signup,
quotas, APIs, or time make a preferred vendor fail, switch to its pivot and
note the swap in that feature's plan. Shared types and HTTP contracts MUST
stay stable so a pivot is a client/config change, not a new product.

**Do not add to MVP:** Solana, Presage, MongoDB Atlas, or a second primary database.

**Platform strategy**: Phase 1 is Chrome extension (Home + Side Panel) + server.
A full AI-native Chromium browser is explicitly out of MVP scope.

**Two UI surfaces**

| Surface | Host | Shows |
| --- | --- | --- |
| Home | Extension new-tab / home page | All workspaces, Other, cross-workspace layout |
| Sidebar | Chrome Side Panel on a web tab | Active tab's workspace, related tabs, plan, actions, chat |

The Next.js app is the API (and may reuse Home components). It is not the
primary in-tab workspace UI.

**Persistence**: Workspaces MUST survive browser restarts via the primary
Postgres (Tiger preferred, Supabase pivot). An "Other" bucket MUST exist for
unorganized tabs. Tab lifecycle MUST be recorded as `tab_events` so activity
questions ("what was I working on yesterday?") have a real data path.
Every durable row MUST be user-scoped from day one.

## Development Workflow & MVP Scope

**Feature order** (Spec Kit features; cut line after 011):

1. Monorepo + shared domain model
2. Tab ingestion extension
3. Workspace persistence API
4. AI clustering
5. Home — all workspaces
6. Chrome sidebar — in-tab workspace
7. Manual correction (+ Chrome sync of moves)
8. Workspace AI chat (sidebar)
9. Plan generation (sidebar)
10. Contextual actions (sidebar)
11. Global command bar (⌘K)
12. (P1) Saved workspaces + soft suggestions
13. (P1) Desktop workspace voice (ElevenLabs)
14. (stretch) Mobile companion

**Quality bar for MVP**: Prefer integration checks of the core loop over
exhaustive unit-test theater. Shared types and API contracts MUST stay in sync.
Secrets and API keys MUST NOT be committed.

**Source of product truth**: `initialspec.txt`. Stack/feature planning detail:
`tech-stack.txt`. This constitution governs how we build; those files govern
what we build.

## Governance

- This constitution supersedes conflicting informal practice for AI Browser
  development.
- Amendments MUST update this file, bump `CONSTITUTION_VERSION` using semver
  (MAJOR: remove/redefine principles; MINOR: add/expand; PATCH: clarify), and
  set **Last Amended** to the amendment date (ISO YYYY-MM-DD).
- Specs, plans, and tasks MUST be reviewed for compliance with Core Principles
  and the locked Technology Stack before implementation.
- Exceptions (e.g. temporary stack deviation) MUST be documented in the relevant
  feature plan with rationale and a path back to compliance.
- Complexity beyond the MVP cut line MUST be justified against Principle VI.

**Version**: 1.3.0 | **Ratified**: 2026-09-19 | **Last Amended**: 2026-09-19
