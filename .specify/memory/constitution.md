<!--
Sync Impact Report
- Version change: (unset/template) → 1.0.0
- Modified principles: [placeholders] → six concrete AI Browser principles
- Added sections: Technology Stack & Platform Constraints; Development Workflow & MVP Scope
- Removed sections: none (template placeholders replaced)
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

### II. Extension Observes; App Decides

The Chrome extension captures browser state and applies tab organization; the
web application and backend own intelligence and persistence.

- The extension MUST handle: tab listing, page content/snippet capture, tab
  change events, and applying workspace assignments (move/group tabs).
- The server/app MUST own: clustering, workspace CRUD, AI context, plans,
  chat, and action execution.
- Clients MUST NOT each invent independent clustering or conflicting workspace IDs.
- Long-term Chromium-fork ambitions MUST NOT block the extension + web MVP.

**Rationale**: Spec §26–27; fastest path to the core demo without building a browser.

### III. User Corrections Win

AI organization MUST remain reversible and subordinate to explicit user control.

- Users MUST be able to drag tabs between workspaces, move tabs to Other,
  create/rename/merge workspaces, and dismiss suggestions.
- Manual corrections MUST override prior AI assignments for those tabs.
- Low-confidence clustering SHOULD suggest ("Add these tabs?") rather than
  silently force moves.
- Corrections SHOULD be retained as feedback signals for future organization.

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

- Language MUST be TypeScript across extension, web app, API, and shared packages.
- Canonical types for Workspace, TabRef, PlanItem, Message, ActionRun, and
  Correction MUST live in a shared package—no divergent parallel models.
- Monorepo layout SHOULD be `apps/extension`, `apps/web`, `packages/shared`
  (pnpm).

**Rationale**: Reduces integration bugs between extension and app during a
one-week build.

### VI. Demo-Hard, Architecture-Soft

Ship the core product loop before polish, stretch platforms, or premature
abstraction.

- MVP MUST prove: ingest → cluster → persist → correct → chat → plan →
  actions → global command bar (⌘K).
- Mobile companion, voice (ElevenLabs), embeddings/pgvector, and saved-workspace
  polish are P1/stretch—they MUST NOT delay P0.
- Prefer working end-to-end paths over incomplete "platform" layers.

**Rationale**: Spec §29; the MVP question is whether AI can turn messy tabs into
a useful persistent workspace.

## Technology Stack & Platform Constraints

Locked stack for MVP planning and implementation (see `tech-stack.txt`):

| Layer | Choice |
| --- | --- |
| Extension | Chrome MV3 + Vite + CRXJS (or Plasmo) |
| Web app | Next.js (App Router) + React + Tailwind |
| Backend | Next.js Route Handlers |
| Data / auth / realtime | Supabase (Postgres; Auth or device token; Realtime optional) |
| AI | Single provider SDK (Claude or GPT-4.1 class) |
| Clustering (MVP) | LLM on title + URL + snippet (no vector DB required) |
| Embeddings | P1 only (e.g. pgvector) |
| Mobile / voice | Stretch (Expo + ElevenLabs) |

**Platform strategy**: Phase 1 is Chrome extension + web app. A full
AI-native Chromium browser is explicitly out of MVP scope.

**Persistence**: Workspaces MUST survive browser restarts via the shared DB.
An "Other" bucket MUST exist for unorganized tabs.

## Development Workflow & MVP Scope

**Feature order** (Spec Kit features; cut line after 010):

1. Monorepo + shared domain model
2. Tab ingestion extension
3. Workspace persistence API
4. AI clustering
5. Workspace UI
6. Manual correction (+ Chrome sync of moves)
7. Workspace AI chat
8. Plan generation
9. Contextual actions (fixed, executable set)
10. Global command bar (⌘K)
11. (P1) Saved workspaces + soft suggestions
12. (stretch) Mobile + voice

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

**Version**: 1.0.0 | **Ratified**: 2026-09-19 | **Last Amended**: 2026-09-19
