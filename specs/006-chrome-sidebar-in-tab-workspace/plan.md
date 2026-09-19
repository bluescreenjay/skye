# Implementation Plan: Chrome Sidebar — In-Tab Workspace

**Branch**: 006-chrome-sidebar-in-tab-workspace | **Date**: 2026-09-19 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from specs/006-chrome-sidebar-in-tab-workspace/spec.md

## Summary

Add a Chrome Side Panel page for the active web tab. It reads that tab's durable workspace assignment and saved member tabs from the existing 003 API, shows Other when unassigned, and reserves visible areas for later plan, action, and chat features. A panel instance tracks the browser window that contains it and refreshes on tab changes. Home remains the toolbar action and the all-workspaces directory.

## Technical Context

**Language/Version**: TypeScript (strict), Node.js 22+, React 19, Chrome Manifest V3

**Primary Dependencies**: Chrome Side Panel, Tabs, and Windows APIs; Vite/CRXJS; existing shared domain types

**Storage**: Existing user-scoped Postgres workspaces and tab references via the 003 API; no new tables or client-side durable workspace state

**Testing**: Vitest for context selection, stale responses, and API view mapping; extension build/typecheck; manual Chrome side panel walkthrough

**Target Platform**: Chrome 116+ desktop (Side Panel open API is available, though this feature uses Chrome's panel picker)

**Project Type**: Chrome extension UI consuming the existing Next.js API

**Performance Goals**: Correct context within 2 seconds for 95% of local tab/window switches when the API is available; never settle on stale context during 20 rapid switches

**Constraints**: Keep toolbar click opening Home; never show incognito/internal page data; no new data permission beyond the sidePanel permission; no API or database changes; server remains the authority for assignments

**Scale/Scope**: One panel view per normal browser window, one active page at a time, a scrollable list of saved tab references

## Constitution Check

*Gate evaluated before research and rechecked after design.*

| Principle | Result | Design consequence |
| --- | --- | --- |
| I. Workspace-First | PASS | Panel reads durable workspace and tab references; closing it changes no stored data. |
| II. Extension Observes and Presents; Server Decides | PASS | Extension displays existing assignments and never clusters or writes placement. |
| III. User Corrections Win | PASS | No automatic reassignment; correction controls remain in 007. |
| IV. Least-Power Actions | PASS | Plan, action, and chat regions are honest placeholders. |
| V. One TypeScript Surface | PASS | Reuse shared Workspace and TabRef types and extract shared Home/Sidebar tab-mark and tab-row components. |
| VI. Demo-Hard, Architecture-Soft | PASS | Use existing 003 reads and a small panel entry, with focused integration checks. |
| VII. Two Surfaces | PASS | Home remains a separate directory; the panel follows the active page. |

No constitution exceptions or unresolved clarifications.

## Phase 0: Research

Decisions and rejected alternatives are recorded in [research.md](research.md). Key decisions: use a default Chrome Side Panel page reached through Chrome's side panel picker; bind each instance to its own browser window; resolve by live tab ID before URL fallback; and use existing workspace/tab-reference read endpoints. Chrome API behavior was verified against the official Chrome extension documentation.

## Phase 1: Design

- [data-model.md](data-model.md) defines ephemeral panel states and reuse of persistent Workspace and TabRef records.
- [contracts/sidebar.md](contracts/sidebar.md) defines opening, context selection, rendering, and existing API reads.
- [quickstart.md](quickstart.md) validates named workspace, Other, rapid switches, window isolation, unavailable pages, and persistence.

## Project Structure

### Documentation (this feature)

~~~text
specs/006-chrome-sidebar-in-tab-workspace/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── contracts/sidebar.md
├── quickstart.md
└── checklists/requirements.md
~~~

### Source Code (repository root)

~~~text
apps/extension/
├── manifest.config.ts            # sidePanel permission and default panel path
├── vite.config.ts                 # build the panel entry beside Home
├── sidepanel.html                 # separate extension page
├── src/background.ts              # existing Home action remains
├── src/filters.ts                 # existing eligible web-page rule
├── src/home/                     # Home keeps the directory view
├── src/ui/                       # shared tab-mark and tab-row components
├── src/sidebar/                  # window context, API reads, view, styles
└── tests/                        # context and API/view integration checks
apps/web/app/api/
├── resolve/route.ts              # existing active-page resolution
└── tab-refs/route.ts             # existing workspace member read
packages/shared/src/domain.ts     # canonical Workspace and TabRef types
~~~

**Structure Decision**: Add one extension page and focused sidebar modules. Extract the small tab-mark and tab-row presentation pieces that Home and Sidebar both use; keep their page layouts separate. Reuse the existing API and shared types. The mock's workspace panel guides visual style; its fake page frame is not part of the Side Panel.

## Post-Design Constitution Check

All seven gates still pass. The design adds only the permission required for Chrome's Side Panel and makes no schema, clustering, or assistant API changes. The existing toolbar action continues to open Home.
