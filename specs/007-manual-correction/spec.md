# Feature Specification: Manual Workspace Correction

**Feature Branch**: `007-manual-correction`

**Created**: 2026-09-19

**Status**: Draft

**Input**: User description: "Add manual workspace correction across both views. On Home, users drag tabs between workspaces and Other, create workspaces, and rename them. In the Chrome sidebar, they can move or recategorize the active tab without leaving the page. Manual moves always win over prior AI clustering. Persist corrections as feedback signals. Sync assignments back through the Chrome extension so the browser’s tab organization matches the workspace model. Do not build ML retraining—just capture and honor corrections."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Fix organization on Home (Priority: P1)

A person opens Home and sees tabs in the wrong workspace (or stuck in Other). They drag pages between named workspaces and Other, rename a workspace so its label matches their intent, and create a new workspace when nothing existing fits. After each change, Home and later views show the corrected membership—not the old AI grouping.

**Why this priority**: Home is the primary place to reorganize across workspaces; without it, AI mistakes stay sticky and trust collapses.

**Independent Test**: With at least two named workspaces and some Other tabs, perform drag, rename, and create on Home. Confirm membership and names match the person’s actions after a refresh.

**Acceptance Scenarios**:

1. **Given** a saved tab in workspace A, **When** the person drags it to workspace B on Home, **Then** it appears under B and no longer under A, and a later reload still shows B.
2. **Given** a saved tab in a named workspace, **When** the person drags it to Other, **Then** it is unassigned from that workspace and listed with Other.
3. **Given** an Other tab, **When** the person drags it onto a named workspace, **Then** it becomes a member of that workspace.
4. **Given** a named workspace, **When** the person renames it, **Then** the new name appears everywhere that workspace is shown for them.
5. **Given** Home with existing workspaces, **When** the person creates a new workspace and assigns at least one tab to it, **Then** the new workspace appears in the directory with that membership.

---

### User Story 2 - Move this tab from the sidebar (Priority: P1)

While reading a web page, a person realizes the page belongs in a different workspace. Without going to Home, they move or recategorize the **active** tab from the sidebar (including sending it to Other or into a named workspace). The page stays open; only its workspace assignment changes.

**Why this priority**: The in-tab promise requires fixing the current page in place; forcing a trip to Home for every misfile breaks the sidebar’s value.

**Independent Test**: On a page assigned to workspace A, move it to B (or Other) from the sidebar. Confirm the sidebar retargets to the new assignment and Home agrees after refresh.

**Acceptance Scenarios**:

1. **Given** an active page in workspace A, **When** the person moves it to workspace B from the sidebar, **Then** the sidebar shows B for that page and the page remains visible.
2. **Given** an active page in a named workspace, **When** the person moves it to Other from the sidebar, **Then** the sidebar shows Other for that page.
3. **Given** an active Other page, **When** the person assigns it to a named workspace from the sidebar, **Then** the sidebar shows that workspace.
4. **Given** a soft “add to this workspace” suggestion for the active page, **When** the person dismisses it, **Then** the suggestion goes away and no membership change occurs.

---

### User Story 3 - Manual wins and the browser follows (Priority: P1)

After a person corrects membership, that correction overrides any prior automatic clustering for those tabs. The browser’s own tab organization (groups or equivalent) is updated so what they see in Chrome matches the durable workspace model—not only the Home/Sidebar labels.

**Why this priority**: Corrections that only update the product UI while Chrome stays wrong feel broken; overrides that AI can silently undo destroy trust.

**Independent Test**: Correct a few tabs on Home or in the sidebar, then confirm (a) a later organize/clustering pass does not put those corrected tabs back against the person’s choice without a new user action, and (b) Chrome’s visible grouping matches the corrected workspaces for open tabs.

**Acceptance Scenarios**:

1. **Given** tabs the person manually placed, **When** automatic organization runs again, **Then** those manually placed tabs keep the person’s assignment unless the person changes them again.
2. **Given** open browser tabs that belong to different workspaces after a correction, **When** the extension applies the sync, **Then** Chrome’s tab organization reflects those workspace boundaries for the paired person.
3. **Given** a corrected assignment, **When** the person closes and reopens the browser or extension, **Then** the saved membership remains and Chrome can be brought back in line without redoing the drag.

---

### User Story 4 - Corrections leave a feedback trail (Priority: P2)

Each manual move, create, rename, and suggestion dismissal is recorded as a correction signal tied to the person and the affected workspace/tab references—so future organization features can learn from overrides. No model training pipeline is required in this feature.

**Why this priority**: Capturing signals is valuable and low-risk; shipping without it still delivers user control.

**Independent Test**: Perform a known set of corrections and confirm each leaves a durable, user-scoped record that identifies what changed—without exposing another person’s data.

**Acceptance Scenarios**:

1. **Given** a drag from A to B, **When** the correction is saved, **Then** a feedback record exists that reflects the before/after assignment for that tab reference.
2. **Given** a dismissed suggestion, **When** the person dismisses it, **Then** a feedback record exists and membership is unchanged.
3. **Given** another paired person, **When** corrections are listed or used, **Then** only the acting person’s corrections are visible or applied.

### Edge Cases

- Dragging onto the same workspace (or Other when already Other) is a no-op and does not create a misleading “success” that implies a change.
- Creating a workspace with an empty or whitespace-only name is rejected with a clear, quiet message; no blank workspace is kept.
- Renaming to a duplicate of another active workspace name for the same person is either rejected clearly or disambiguated without merging workspaces silently.
- Moving the active tab from the sidebar while the membership request fails leaves the previous assignment visible and does not pretend Chrome already moved.
- A tab with no live browser tab (closed page still saved) can still be reassigned on Home; Chrome sync only applies to currently open eligible tabs.
- Incognito, internal, and extension pages are never reassigned or grouped as if they were ordinary workspace members.
- Concurrent edits (two Home windows, or Home plus sidebar) resolve to the durable saved state; the person can refresh to see the truth—no silent split-brain memberships for the same tab reference.
- Archiving or removing a workspace the person just emptied is out of scope unless already supported elsewhere; this feature does not require destructive archive flows to ship.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: On Home, the person MUST be able to move saved tab references between named workspaces and Other by direct manipulation (drag or equivalent clear control).
- **FR-002**: On Home, the person MUST be able to rename an existing named workspace they own.
- **FR-003**: On Home, the person MUST be able to create a new named workspace and place at least one tab into it as part of ordinary correction flow.
- **FR-004**: In the sidebar, the person MUST be able to move or recategorize the **active** eligible page among their named workspaces and Other without navigating away from the page.
- **FR-005**: The person MUST be able to dismiss an active-page workspace suggestion without changing membership.
- **FR-006**: Every successful manual membership or naming change MUST persist for the paired person and MUST be reflected on Home and in the sidebar after reload.
- **FR-007**: Manual corrections MUST take precedence over prior automatic clustering assignments for the affected tab references until the person changes them again.
- **FR-008**: The extension MUST update the browser’s tab organization (native groups or an equally clear equivalent) so open eligible tabs match the durable workspace model after corrections.
- **FR-009**: The product MUST record user-scoped correction feedback for manual moves, creates/renames that correct organization, and suggestion dismissals—without requiring any model retraining in this feature.
- **FR-010**: Failed saves or failed browser sync MUST surface a clear non-destructive state; the product MUST NOT claim success when durable membership or browser sync did not complete.
- **FR-011**: This feature MUST NOT train or fine-tune models from corrections, MUST NOT invent client-only workspaces that the server does not own, and MUST NOT reassign tabs belonging to another person.

### Key Entities

- **Workspace**: Named collection the person corrects; may be created or renamed by them.
- **Saved tab reference**: Durable page membership that may move between workspaces and Other even when its browser tab is closed.
- **Other**: Unassigned bucket; a valid destination and source for corrections.
- **Correction**: User-scoped feedback record of an override (move, organizational create/rename, or suggestion dismissal).
- **Active page**: The focused eligible browser tab the sidebar may recategorize.
- **Suggestion**: Soft prompt to add or place tabs; dismissible without membership change.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a walkthrough with at least two named workspaces and Other, 100% of Home drag, rename, and create corrections remain correct after reload.
- **SC-002**: In a walkthrough moving the active page from the sidebar among A, B, and Other, the sidebar shows the new assignment within 2 seconds in at least 95% of local trials when the service is available.
- **SC-003**: After a batch of manual placements, a subsequent automatic organize pass leaves 100% of those manually placed tabs on the person’s chosen assignment (absent a new user edit).
- **SC-004**: For open eligible tabs after corrections, a reviewer can match Chrome’s visible organization to the Home workspace membership for at least 95% of those tabs in a local demo set.
- **SC-005**: In a first-use correction walkthrough, the person can fix one misfiled tab on Home and one from the sidebar without leaving those surfaces’ primary flows.

## Assumptions

- Features 002 (ingestion), 003 (persistence), 005 (Home), and 006 (sidebar) are available so corrections have something to show and somewhere to edit.
- Feature 004 may have created the initial AI assignments; this feature does not require a new clustering run to ship.
- Soft suggestions may already exist from clustering; this feature only requires dismiss-without-apply when a suggestion is shown—not a full suggestions inbox redesign.
- “Browser tab organization matches the model” means Chrome tab groups (or the clearest built-in equivalent available to the extension); it does not require a custom Chromium fork.
- Merge of two workspaces into one, bulk multi-select of dozens of tabs, and full archive/delete workspace flows are not required to satisfy this feature’s done-when unless already present.
- Correction records are retained as signals for later learning; building or running a training pipeline is explicitly out of scope.
- Home remains the primary cross-workspace organizer; the sidebar only corrects the active page (plus dismissing a suggestion for that page).
