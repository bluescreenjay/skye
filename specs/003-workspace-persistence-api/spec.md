# Feature Specification: Workspace Persistence API

**Feature Branch**: `003-workspace-persistence-api`

**Created**: 2026-09-19

**Status**: Draft

**Input**: User description: "Build the workspace persistence API for AI Browser on Tiger Data. Users need durable, user-scoped workspaces that survive closing tabs and the browser. Support creating/listing/renaming/archiving workspaces, assigning tab refs to a workspace or to an Other bucket, resolving the workspace for an active tab, and appending tab lifecycle rows to a tab_events hypertable. Home (directory) and the Chrome sidebar share this API via a device pairing token. No AI clustering yet—manual and API-driven assignment is enough."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Workspaces survive closing the browser (Priority: P1)

A person organizes their work into named workspaces (create, list, rename, archive). They quit the browser or close every tab. Later they come back and see the **same** workspaces for **themselves only**—not an empty slate, and not someone else’s work.

**Why this priority**: This is the core product promise (constitution: closing the browser must not destroy a workspace). Without it, Home and Sidebar have nothing durable to show.

**Independent Test**: Create two workspaces, rename one, archive one. Simulate a full restart (new session). List workspaces: the active/renamed one remains; the archived one is not in the active list but can still be retrieved as archived. A second person (or unpaired client) does not see the first person’s workspaces.

**Acceptance Scenarios**:

1. **Given** a paired client, **When** the user creates a workspace with a name (and optional emoji), **Then** that workspace appears in their list with status active.
2. **Given** an existing workspace, **When** the user renames it, **Then** later lists show the new name and the same identity.
3. **Given** an existing workspace, **When** the user archives it, **Then** it no longer appears in the default active list and is not deleted from history.
4. **Given** workspaces already saved, **When** the client starts a new session (browser quit and reopen, or equivalent), **Then** the same user-scoped list loads without the user recreating it.
5. **Given** two different users, **When** each lists workspaces, **Then** neither sees the other’s workspaces.

---

### User Story 2 - Tabs belong to a workspace or to Other (Priority: P1)

The user (or a later ingestion client) assigns pages to a workspace or to Other. Membership is stored so Home can show “these tabs are in Hackathon” and the sidebar is not guessing.

**Why this priority**: Workspaces without tab membership are empty labels. Other is required so casual pages are not forced into a project.

**Independent Test**: Create a workspace, assign two tab references to it and one to Other. Reload. Those three memberships are unchanged. Moving a tab from the workspace to Other (or the reverse) persists.

**Acceptance Scenarios**:

1. **Given** a workspace, **When** a tab reference (address, title, optional short excerpt, optional live tab id) is assigned to it, **Then** it appears as a member of that workspace for that user.
2. **Given** a tab reference, **When** it is assigned to Other, **Then** it has no workspace and still belongs to that user.
3. **Given** a tab already in a workspace, **When** it is moved to another workspace or to Other, **Then** it is no longer a member of the previous workspace.
4. **Given** a workspace with zero tab references, **When** the user lists workspaces, **Then** the workspace still exists.

---

### User Story 3 - Sidebar can ask “which workspace is this tab in?” (Priority: P1)

While looking at a web page, the in-tab experience needs to know whether this page is in a workspace or in Other, without the user explaining it. The persistence layer answers from stored membership (live tab id when known, otherwise the page address).

**Why this priority**: Constitution Two Surfaces: switching tabs retargets the sidebar. This feature does not build the sidebar UI; it provides the lookup the sidebar will call.

**Independent Test**: Assign a tab to workspace A. Resolve “workspace for this tab” using that tab’s live id and/or address. Response is workspace A. Unassigned address resolves to Other. A tab belonging to another user does not resolve to A.

**Acceptance Scenarios**:

1. **Given** a stored tab reference with a live tab id in workspace A, **When** the client asks which workspace that live tab is in, **Then** the answer is workspace A.
2. **Given** no live tab id but a matching stored address for this user, **When** the client asks which workspace that page is in, **Then** the answer is that workspace or Other as stored.
3. **Given** no matching tab reference for this user, **When** the client asks, **Then** the answer is Other (unassigned), not an error that implies the product is broken.
4. **Given** a tab in Other, **When** the client asks, **Then** the answer is Other, not a fabricated workspace.

---

### User Story 4 - Tab changes are recorded over time (Priority: P2)

Each meaningful tab change (opened, updated, activated, closed, or reassigned) is stored as a point-in-time fact so later “what was I working on yesterday?” is possible. This feature records events; it does not build that report UI.

**Why this priority**: Needed for later activity questions; not required to prove “workspaces persist.” Can ship after P1 stories.

**Independent Test**: Perform assign/open/move operations. Event history for that user contains corresponding records in time order. Events for another user are not included.

**Acceptance Scenarios**:

1. **Given** a paired client, **When** a tab lifecycle change is submitted (type + time + page identity + optional workspace), **Then** it is stored and listed in time order for that user.
2. **Given** stored events, **When** the user restarts the client, **Then** those events are still available (not only the latest snapshot).
3. **Given** a reassignment from one workspace to Other (or another workspace), **When** events are listed, **Then** a reassigned (or equivalent) event is present without deleting older events.

---

### User Story 5 - Home and Sidebar share one user via pairing (Priority: P1)

The directory (Home) and the in-tab sidebar are different clients. They must attach to the same person so they see the same workspaces. A simple device pairing token is enough for MVP (not a full account product).

**Why this priority**: Without shared identity, Home and Sidebar fork into two products. Constitution: clients must not invent conflicting workspace IDs.

**Independent Test**: Pair client A (Home) and client B (Sidebar) with the same token. Create a workspace on A; B lists it. A third client with a different token does not list it.

**Acceptance Scenarios**:

1. **Given** an unpaired client, **When** it presents a pairing token (new or existing), **Then** it is bound to exactly one user for subsequent requests.
2. **Given** two clients using the same pairing token, **When** one creates or assigns work, **Then** the other sees that work after refresh.
3. **Given** a request with no valid pairing, **When** it tries to list or change workspaces, **Then** it is rejected and no other user’s data is returned.
4. **Given** a pairing token, **When** it is stored, **Then** the raw token is not kept as recoverable workspace data (only a non-reversible verifier, or equivalent).

---

### Edge Cases

- What if the user archives a workspace that still has tab references? Tabs stay attached unless explicitly moved; archive hides the workspace from the default list, it does not wipe membership.
- What if two tab references share the same address but different live tab ids? Resolve-by-live-id wins when provided; otherwise the most recently seen matching address for that user.
- What if assign points at another user’s workspace id? The request MUST fail; no cross-user writes.
- What if the preferred time-series store is unavailable? Persist tab events as ordinary time-ordered records in the same database; do not block P1 stories.
- What if pairing tokens leak? Treat them like passwords: hashed at rest, HTTPS in transit; rotating a token is out of scope for this feature unless cheap.
- Duplicate create of the same name: allowed (names are labels, identity is the workspace id).
- Empty name: rejected.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST create, list, rename, and archive workspaces for the authenticated user only.
- **FR-002**: Default list MUST return active (non-archived) workspaces; archived workspaces MUST remain retrievable without appearing in that default list.
- **FR-003**: Closing the browser or all tabs MUST NOT delete workspaces or tab memberships.
- **FR-004**: The system MUST create and update tab references (address, title, optional excerpt, optional live tab id) and assign them to a workspace or to Other (`workspace` absent).
- **FR-005**: Moving a tab reference MUST change membership so it belongs to at most one workspace (or Other).
- **FR-006**: The system MUST resolve the workspace (or Other) for the current tab using live tab id when present, otherwise the page address, scoped to the current user.
- **FR-007**: The system MUST append tab lifecycle events (opened, updated, activated, closed, reassigned) as time-ordered records that survive restart.
- **FR-008**: Home and Sidebar MUST authenticate with a shared device pairing token that maps to one user; unauthenticated requests MUST NOT read or write workspace data.
- **FR-009**: Every read/write MUST be user-scoped. The system MUST NOT return or mutate another user’s workspaces, tabs, or events.
- **FR-010**: Pairing secrets MUST NOT be stored in recoverable form (hash or equivalent).
- **FR-011**: This feature MUST NOT implement AI clustering, Home UI, Sidebar UI, chat, plans, or the command bar. Those clients MAY call this API once they exist.
- **FR-012**: Workspace identity MUST be the shared domain id (same id Home and Sidebar will use). Clients MUST NOT mint a second workspace identity scheme.

### Key Entities

- **User**: Owner of work; established via device pairing.
- **Workspace**: Durable named container (active / saved / archived). Survives zero tabs.
- **Tab reference**: A page membership (url, title, snippet, optional live tab id) in a workspace or Other.
- **Tab event**: Time-ordered lifecycle fact for later activity questions.
- **Device pairing**: Shared secret between Home, Sidebar, and server that selects the User.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After creating at least two workspaces and assigning at least three tabs, a full client restart still shows 100% of those workspaces and memberships for that user within 10 seconds of reload.
- **SC-002**: 0% of workspace, tab, or event records from user A appear in user B’s list or resolve results in a two-user check.
- **SC-003**: A paired “sidebar-like” client can resolve the workspace (or Other) for a known tab in one round trip and get the same workspace id the “home-like” client listed.
- **SC-004**: 100% of tested assign/move operations persist after restart (no membership silently reverting).
- **SC-005**: An unpaired client cannot list or create workspaces (requests fail; empty or error, never another user’s data).
- **SC-006**: A workspace with zero tabs still lists after restart (proves work is not “whatever is open”).
- **SC-007**: This feature ships with no clustering and no Home/Sidebar screens; success is “API keeps work,” not “browser demo.”

## Assumptions

- Feature 001 shared domain model (types and SQL skeleton) already exists and is the source of entity shapes.
- Feature 002 (tab ingestion extension) may not be done yet. This API must be usable from a simple HTTP client or a stub so 002 can attach later. Manual assignment is enough.
- Preferred database is the constitution primary Postgres (Tiger Data). Tab events MAY be a hypertable later; they MUST work as ordinary time-ordered rows if Timescale is unused (constitution pivot).
- Device pairing is MVP auth. Full email/OAuth can wait if `user_id` is set from pairing.
- “Saved” vs “archived”: archive is the hide-from-default-list action for this feature; explicit “save” polish is feature 012.
- HTTPS locally may be a tunnel or localhost; tokens still must not be logged in full.
- Names need not be unique per user.
- No [NEEDS CLARIFICATION] items: scope (API only), pairing, Other-as-null, and no clustering are already decided.
