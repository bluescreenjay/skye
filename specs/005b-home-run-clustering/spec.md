# Feature Specification: Home → run clustering

**Feature Branch**: `005b-home-run-clustering`

**Created**: 2026-09-19

**Status**: Draft

**Input**: User description: "Add a thin Home trigger for AI Browser clustering. Home already lists workspaces and Other from prior features. Clustering already runs on the server. Wire a single organize control on Home that starts that organization for the paired person, then refreshes the directory so named workspace cards appear. Do not move clustering logic into the extension. Do not build the Side Panel, command bar, create-workspace, or a full suggestions UI—high-confidence apply from the existing server behavior is enough; low-confidence suggestions can stay server-side until a later correction feature. Keep the mock Home layout; only add the minimum chrome needed to start a run and show loading or failure."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Organize from Home (Priority: P1)

A person has open pages sitting in Other on Home. They use one clear organize control on Home. After a short wait, named workspace cards appear (and Other shrinks) without leaving Home and without using developer tools or hand-written requests.

**Why this priority**: Without this trigger, clustering stays invisible in the product even though the server can already organize tabs. This is the demo path from messy Other to a map of work.

**Independent Test**: With several ungrouped pages for the paired identity and organization available on the server, use only the Home control and confirm the directory updates to show named workspaces.

**Acceptance Scenarios**:

1. **Given** Home shows Other icons and few or no named workspace cards, **When** the person activates organize, **Then** Home shows that organization is in progress (they are not left wondering if anything happened).
2. **Given** organization succeeds and creates or updates named workspaces, **When** the run finishes, **Then** Home refreshes so those workspaces appear as cards (and rail tiles) and Other no longer lists tabs that were assigned.
3. **Given** the person stays on the Home tab, **When** organization completes, **Then** they never have to open a different product surface or leave Home to see the result.

---

### User Story 2 - Understand failure without breaking Home (Priority: P1)

If pairing is wrong, the organization service is unavailable, or organization cannot run, Home keeps its existing layout and shows quiet, readable failure copy. The person can try again later.

**Why this priority**: A failed organize must not blank Home or invent fake workspaces.

**Independent Test**: Force a failure (unpaired identity, service down, or organization refused) and confirm Home chrome remains and failure is visible.

**Acceptance Scenarios**:

1. **Given** Home cannot reach the organization service or is unpaired, **When** the person activates organize, **Then** they see a short failure message and the directory does not invent dummy named workspaces.
2. **Given** organization is already running for this person, **When** they activate organize again, **Then** Home does not corrupt the directory; it either waits, ignores the duplicate, or explains that a run is already in progress.
3. **Given** organization reports nothing useful to apply (for example nothing changed or no confident groups), **When** the run finishes, **Then** Home still shows a clear outcome (including “nothing to organize” style copy if that is the truth) and keeps the prior real directory.

---

### User Story 3 - Stay out of later features (Priority: P2)

Organize does not become a command bar, Side Panel, create-workspace form, or a full accept/ignore suggestions board. Low-confidence suggestions may remain on the server for a later feature.

**Why this priority**: Keeps 005b thin so 006/007/011 stay distinct.

**Independent Test**: Review Home after 005b: only the minimum organize chrome was added; no Side Panel, no ⌘K, no create-workspace control, no suggestions inbox UI.

**Acceptance Scenarios**:

1. **Given** Home after this feature, **When** the person looks for ways to organize, **Then** they find the single Home organize control—not a global command bar and not the Side Panel.
2. **Given** the server stored low-confidence suggestions, **When** this feature ships, **Then** Home is not required to show a full suggestions list or accept/ignore UI (that waits for later correction work).

---

### Edge Cases

- Person activates organize with an empty Other and no open work to group.
- Person activates organize while the directory is still loading.
- Organization takes a long time; person navigates away from Home or closes the tab mid-run.
- Organization succeeds but creates workspaces the person already renamed or rearranged; directory must show server truth after refresh, not stale local guesses.
- Misconfigured organization (for example missing model access on the server) must fail clearly without crashing Home.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Home MUST provide one clear control that starts organization for the currently paired person.
- **FR-002**: Starting organization MUST use the same pairing identity Home already uses to load the directory—not a separate account.
- **FR-003**: Home MUST NOT decide groups, names, or memberships itself; organization decisions MUST remain on the existing server capability from the clustering feature.
- **FR-004**: While a run is in progress, Home MUST show a quiet in-progress state on or near the organize control.
- **FR-005**: When a run finishes successfully, Home MUST reload the directory (workspaces and Other) so cards and rail icons match what the server stored.
- **FR-006**: When a run fails or cannot start, Home MUST keep the existing Home chrome and show short failure copy; it MUST NOT seed dummy furniture-style workspaces.
- **FR-007**: This feature MUST NOT add Side Panel, global command bar, create-workspace, or a full suggestions accept/ignore surface.
- **FR-008**: Visual changes MUST stay minimal relative to the existing Home mock layout—only what is needed for the organize control and its loading/failure states.
- **FR-009**: High-confidence groups applied by the existing server behavior are enough for this feature; Home is not required to present low-confidence suggestions.

### Key Entities

- **Organization run**: A single request by the person to group their current work; ends in success, failure, in-progress conflict, or “nothing to do.”
- **Directory**: The Home view of named workspaces plus Other; refreshed after a successful run.
- **Other**: Ungrouped pages; expected to shrink when organization assigns pages to named workspaces.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a demo with at least eight ungrouped pages that the server can organize, a person can go from Other-only Home to seeing at least one named workspace card using only the Home organize control, in under two minutes of wall time excluding first-time model setup.
- **SC-002**: After a successful run, a Home reload (or the automatic refresh) shows the same named workspaces and Other membership the person just saw—no need to re-run organize to “make it stick.”
- **SC-003**: On failure (unpaired, service down, or organization refused), 100% of test runs leave Home’s rail and main chrome intact with readable failure copy and zero dummy seeded workspace names.
- **SC-004**: A reviewer can confirm in one pass that Home gained organize chrome only—no Side Panel, no command bar, no create-workspace control shipped in this feature.

## Assumptions

- Home (005) and server clustering (004) already ship; this feature only connects them for the paired person.
- Tabs have already been ingested for that person so Other is not empty in the happy path.
- High-confidence apply vs low-confidence suggest behavior stays as the clustering feature defined it; 005b does not redefine confidence rules.
- Full suggestions UX and manual create-workspace remain later features (007+).
- Global natural-language organize (command bar) remains a later feature and may reuse this same server organization capability.
- The existing Home visual mock remains the layout source of truth; organize is an additive control, not a redesign.
