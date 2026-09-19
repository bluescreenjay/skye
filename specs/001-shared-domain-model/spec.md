# Feature Specification: Shared Domain Model

**Feature Branch**: `001-shared-domain-model`

**Created**: 2026-09-19

**Status**: Draft

**Input**: User description: "Set up the AI Browser monorepo foundation: pnpm workspaces with apps/extension, apps/web, and packages/shared. Define shared TypeScript types for User, Workspace, TabRef, TabEvent, PlanItem, Message, ActionRun, and Correction. Every durable type is user-scoped. Add a Tiger Data (Timescale Postgres) schema skeleton: ordinary workspace tables plus a tab_events hypertable for tab lifecycle over time. Env examples for Tiger and Gemini. No product UI or AI behavior yet—only the shared foundation other features will build on. The product will have two views later (Home for all workspaces, Chrome sidebar on a tab); types must support both. Closing the browser must not imply data loss once persistence lands later; model workspaces as durable entities from day one."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One shared meaning of a workspace (Priority: P1)

A teammate starting the next feature (tab ingestion, Home, or Sidebar) can look in one place and see what a user, workspace, tab, plan item, message, action run, and correction mean—and know those meanings are the same for every product surface.

**Why this priority**: If Home and the in-tab sidebar invent different workspace identities, the product cannot keep a single persistent workspace. This is the load-bearing slice of the foundation.

**Independent Test**: Review the shared model: each listed concept exists once, is user-scoped where it is durable, and can be imported by both the browsing surface and the server surface without a second copy of the definitions.

**Acceptance Scenarios**:

1. **Given** the foundation is in place, **When** someone inspects the shared model, **Then** they find a single definition for User, Workspace, Tab (as a reference to a page), Tab event (a change over time), Plan item, Message, Action run, and Correction.
2. **Given** Home and Sidebar will be built later, **When** both consume the shared model, **Then** they can refer to the same workspace by the same identity without translating between two schemas.
3. **Given** a durable record (workspace, tab reference, event, plan item, message, action run, or correction), **When** it is stored in the model, **Then** it is associated with exactly one user.

---

### User Story 2 - Work survives closing the browser (Priority: P1)

The product treats a workspace as something that outlives open tabs. This feature does not yet save live browsing sessions, but it MUST define workspaces as durable records (not “whatever tabs happen to be open”) so later persistence can keep work after Chrome is quit.

**Why this priority**: Constitution Principle I: closing tabs or the browser must not destroy a workspace. If the foundation models work as ephemeral tab lists, later features cannot keep the core promise.

**Independent Test**: Inspect the workspace concept: it exists independently of any live browser tab id; tab references and time-ordered tab events attach to workspaces (or to Other) without being the workspace itself.

**Acceptance Scenarios**:

1. **Given** a workspace in the model, **When** all of its tab references are removed or no browser is running, **Then** the workspace record can still exist (active, saved, or archived).
2. **Given** a page the user visited, **When** it is represented in the model, **Then** it can belong to a workspace or to Other (no workspace), without deleting the user’s other work.
3. **Given** tab activity over a day, **When** it is represented, **Then** it is a sequence of events in time, not only “the latest snapshot,” so later “what was I working on yesterday?” is possible.

---

### User Story 3 - Later surfaces can be configured without leaking secrets (Priority: P2)

Someone setting up a development copy of the project can see which external services later features will need (data store, language model, later voice) and where to put credentials locally, without any real secrets committed to the shared repo.

**Why this priority**: Later clustering, chat, and voice cannot start if the project has no safe place for configuration. Shipping secrets would violate project governance.

**Independent Test**: Open the example environment files: required service slots are named; no live keys or tokens are present in the committed tree.

**Acceptance Scenarios**:

1. **Given** a fresh clone, **When** a developer looks for configuration examples, **Then** they find placeholders for the primary data store and the primary language-model service (and an optional later voice service).
2. **Given** those examples, **When** the repository is inspected for secrets, **Then** no production or personal API keys are stored in committed files.

---

### User Story 4 - Empty product shells exist so Home and Sidebar are not invented twice (Priority: P2)

The repository is organized so the browsing extension (future Home + Sidebar) and the server (future persistence and AI) are sibling parts of one project, sharing the domain model, with no product screens or clustering behavior yet.

**Why this priority**: Principle V (one typed surface) and Principle VII (two views later). Empty shells prevent the next features from starting as disconnected apps.

**Independent Test**: Confirm three parts exist: extension app shell, server/web app shell, shared model package. Neither shell is required to show a user-facing workspace UI in this feature.

**Acceptance Scenarios**:

1. **Given** the foundation, **When** a developer opens the project layout, **Then** they can point to the extension area, the server/web area, and the shared model area as separate but connected parts of one repo.
2. **Given** this feature is complete, **When** a user launches Chrome, **Then** they are not promised a working Home, Sidebar, chat, or clustering experience yet—those are later features.

---

### Edge Cases

- What happens if a tab event has no workspace? It belongs to Other (unassigned), still scoped to a user.
- What happens if two surfaces need a workspace at once (Home list and Sidebar for the active tab)? They MUST use the same workspace identity; this feature does not implement those UIs.
- How does the system handle a missing user on a durable record? The model MUST NOT allow durable work without a user association.
- What if the preferred data store (time-series capable Postgres) is unavailable? Pivot to the constitution fallback store with the same entities; `tab_events` may be ordinary historical rows instead of a specialized time-series table.
- What if environment files are copied from examples with blank values? Later features that need live services will fail closed until values are supplied; this feature does not call those services.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The project MUST be a single repository with distinct areas for (a) the browser extension, (b) the server/web application, and (c) a shared domain model used by both.
- **FR-002**: The shared model MUST define User, Workspace, Tab reference, Tab event, Plan item, Message, Action run, and Correction as first-class concepts.
- **FR-003**: Every durable concept in FR-002 except User itself MUST be scoped to a user so one person’s work is not mixed with another’s.
- **FR-004**: A Workspace MUST be modelable independently of live browser tabs, including status at least: active, saved, and archived.
- **FR-005**: A Tab reference MUST be assignable to a workspace or to Other (no workspace) and MAY record last-seen page title, address, short excerpt, and a browser tab identifier when known.
- **FR-006**: A Tab event MUST represent a point-in-time tab lifecycle change (for example opened, updated, activated, closed, or reassigned) so activity can be queried over time.
- **FR-007**: The data-store skeleton MUST include ordinary records for users and workspaces and a time-ordered store for tab events suitable for later “what was I working on yesterday?” questions.
- **FR-008**: Home (all workspaces) and Sidebar (in-tab workspace) MUST be representable with this model without extra conflicting identity fields; this feature MUST NOT implement those views.
- **FR-009**: This feature MUST NOT deliver product UI, tab clustering, chat, plans, actions, or a command bar.
- **FR-010**: Example configuration MUST exist for the primary data store and primary language-model service, and MAY include a placeholder for later voice; committed examples MUST NOT contain real secrets.
- **FR-011**: Both the extension area and the server/web area MUST be able to consume the shared model (import or equivalent) so later features do not copy-paste entity definitions.

### Key Entities *(include if feature involves data)*

- **User**: A person (or device-bound account) who owns work. Identified uniquely; later pairing of extension and server attaches to this user.
- **Workspace**: Persistent container of a task or project. Has a name, optional emoji, status (active / saved / archived), and timestamps. Survives with zero open tabs.
- **Tab reference**: A page the user has open or recently had open (address, title, short excerpt, optional live browser tab id). Belongs to one workspace or to Other.
- **Tab event**: A timestamped fact about a tab (seen, changed, activated, closed, moved between workspaces). Used later for activity and “yesterday” questions.
- **Plan item**: A checklist step on a workspace (text, done or not, order). Defined now; filled in a later feature.
- **Message**: One turn of workspace conversation (role and content). Defined now; filled in a later feature.
- **Action run**: A recorded attempt to do a workspace action (which action, input, output, status). Defined now; filled in a later feature.
- **Correction**: A user override of automatic grouping (from workspace, to workspace or Other, signals about the tab). Defined now; filled in a later feature.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A reviewer can locate the single shared definitions for all eight domain concepts in under 5 minutes without asking which copy is canonical.
- **SC-002**: 100% of durable non-user records in the skeleton are user-scoped (no global unowned workspace, tab, event, plan, message, action, or correction).
- **SC-003**: A workspace can be described in the model with zero attached tab references and still remain a valid workspace (supports “close everything, keep the work”).
- **SC-004**: Two future product views (directory of all workspaces vs in-tab workspace) can be planned against this model without adding a second workspace identity scheme.
- **SC-005**: A fresh clone contains configuration examples for data store and language-model access, and a secret scan of committed files finds no live credentials.
- **SC-006**: This feature ships with no user-facing Home, Sidebar, clustering, or chat; those remain later features. Completeness is “foundation ready,” not “browser demo ready.”

## Assumptions

- Locked product constitution applies: workspaces are the unit of product; extension will later host Home and Side Panel; server owns intelligence; prize vendors are preferred with documented pivots.
- Preferred data store is Tiger Data (time-series Postgres); pivot is ordinary Postgres (including Supabase) with the same entities. Preferred language model is Gemini; pivot is Claude or GPT-class. This spec does not require those vendors to be live yet—only that the skeleton and examples can target them.
- Device pairing or equivalent user identity is enough for MVP; full multi-user product accounts can be added later if `user_id` exists from day one.
- “Other” is modeled as a tab reference with no workspace, not as a fake workspace row, unless a later feature proves a sentinel workspace is simpler—either way there is one unambiguous unassigned bucket per user.
- Short page excerpts are enough for later clustering; full page HTML is out of scope for this model.
- Empty extension and server shells may be minimal placeholders (they need not be installable stores or public websites yet).
- No [NEEDS CLARIFICATION] items: scope (foundation only), user-scoping, and two-view support are already decided in the constitution and feature checklist.
