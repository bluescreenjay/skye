# Feature Specification: Chrome Sidebar — In-Tab Workspace

**Feature Branch**: 006-chrome-sidebar-in-tab-workspace

**Created**: 2026-09-19

**Status**: Draft

**Input**: User description: "Build the in-tab workspace as a Chrome Side Panel. When the user is on a web page, the sidebar shows the workspace that tab belongs to (or Other), its related tabs, and placeholder areas for plan, suggested actions, and chat. Switching tabs must update the sidebar to the newly active tab's workspace. The user stays on the page—the workspace comes to them. Home remains the all-workspaces directory; the sidebar must not replace it. Chat replies, live plans, and real actions can be stubbed until later features."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See the workspace beside my page (Priority: P1)

While reading a web page, a person opens the sidebar and sees the workspace assigned to that page. The page remains visible and usable. The sidebar shows the workspace name and its saved related tabs, giving immediate context without sending the person to Home.

**Why this priority**: It completes the second primary product surface: the workspace follows the page.

**Independent Test**: With one page assigned to a named workspace containing several saved tabs, open the sidebar from that page. Confirm the name and member tabs match Home while the page remains open.

**Acceptance Scenarios**:

1. **Given** an active web page assigned to a named workspace, **When** the person opens the sidebar, **Then** it identifies that workspace and lists its saved tabs.
2. **Given** a visible sidebar, **When** the person reads or interacts with the active page, **Then** the page stays in place and usable.
3. **Given** a workspace whose browser tabs have since closed, **When** a saved page in that workspace is active, **Then** its saved workspace identity and tab list remain available.
4. **Given** a related tab in the list, **When** the person chooses it, **Then** its page opens or becomes active without replacing the sidebar with Home.
5. **Given** a saved page that is still open in the browser, **When** the person chooses that page from Home, **Then** Chrome focuses the existing tab and opens Skye in the Side Panel for that tab.
6. **Given** the sidebar is open on a web page, **When** the person activates the Home tab (or chooses Home from the panel), **Then** the Side Panel closes and does not stay open beside Home.

---

### User Story 2 - Follow the active tab (Priority: P1)

The sidebar changes context as the person switches among web tabs. Pages in the same workspace share one workspace view; an unassigned page shows Other. A loading result from a previous tab must not overwrite the current tab's view.

**Why this priority**: A panel stuck on the previous page is misleading and breaks the in-tab promise.

**Independent Test**: Keep the sidebar open and switch between two named workspaces, an Other page, and back. Each selection shows the correct context.

**Acceptance Scenarios**:

1. **Given** the sidebar is open on workspace A, **When** the person activates a page in workspace B, **Then** the sidebar shows B and B's saved tabs.
2. **Given** an unassigned web page, **When** it becomes active, **Then** the sidebar explicitly shows Other rather than inventing a named workspace.
3. **Given** rapid tab switching, **When** an older lookup finishes after a newer one, **Then** the sidebar still represents the currently active tab.
4. **Given** a page with no saved tab reference yet, **When** it becomes active, **Then** the sidebar shows a quiet Other state until current saved data is available.
5. **Given** a tab is closed or a different browser window gains focus, **When** the active page changes, **Then** the sidebar follows the active eligible page in that window.

---

### User Story 3 - See future workspace tools without losing work (Priority: P2)

The sidebar has recognizable areas for a plan, suggested actions, and chat. These areas can show empty or placeholder content now. Closing and reopening the panel does not remove a workspace or its saved tabs.

**Why this priority**: The sidebar must provide the workspace shape needed for later assistant features without making those features prerequisites.

**Independent Test**: Open the panel on a named workspace, inspect the three tool areas, close it, and reopen it. The workspace and related tabs are unchanged.

**Acceptance Scenarios**:

1. **Given** any eligible page, **When** the sidebar opens, **Then** plan, actions, and chat each have a distinct visible area with clear empty or placeholder copy.
2. **Given** the panel is closed and reopened, **When** the same page remains active, **Then** the same saved workspace and related tabs return.
3. **Given** a placeholder tool control, **When** the person uses it, **Then** it does not claim to have completed a real plan, action, or chat reply.

### Edge Cases

- A browser-internal, extension, local-file, or incognito page must not show another web page's workspace; show a neutral unavailable state or keep the panel closed.
- Missing pairing, unavailable service, and delayed loading show a clear, non-destructive state; never display another person's data or mock seed data.
- An archived workspace is not presented as an active destination; if an active page still refers to it, show a neutral unavailable or Other state until that mismatch is resolved.
- Long names and large tab lists remain readable within the panel's narrow width; the list scrolls without hiding the current workspace label.
- Multiple browser windows keep their active-page context separate. A late result from one window must not replace the context shown for another.
- A current page may share a URL with saved references; the live tab's identity takes precedence over a different saved copy.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The product MUST offer an in-browser sidebar on eligible web pages without navigating away from the active page or replacing Home.
- **FR-002**: The sidebar MUST identify the active page's saved workspace, or show Other when no workspace is assigned.
- **FR-003**: For a named workspace, the sidebar MUST show that workspace's saved member tabs, including saved pages whose browser tabs are closed.
- **FR-004**: The sidebar MUST retarget when the active tab or focused browser window changes and MUST ignore stale results for previously active pages.
- **FR-005**: Selecting a listed tab MUST open or activate that page without turning the sidebar into the Home directory.
- **FR-006**: The sidebar MUST contain distinct plan, suggested action, and chat regions; they MAY display honest placeholders until features 008–010 supply real behavior.
- **FR-007**: Opening, closing, or switching the sidebar MUST NOT create, rename, archive, or delete workspaces or change tab assignments.
- **FR-008**: The sidebar MUST use the same workspace identity and saved membership shown on Home for the paired person; it MUST NOT invent client-only workspaces or use sample projects as user data.
- **FR-009**: The sidebar MUST show clear loading, unavailable, unpaired, and Other states without exposing data from a previous page or another person.
- **FR-010**: Browser-internal, extension, local-file, and incognito pages MUST NOT inherit the last eligible page's workspace context.
- **FR-011**: This feature MUST NOT add live chat replies, plan generation, action execution, a cross-workspace directory, or manual reassignment controls.
- **FR-012**: Choosing a saved page from Home MUST focus its matching live browser tab and open Skye in that tab's Side Panel. It MAY open a new tab only when the saved browser tab is closed or stale.
- **FR-013**: The Side Panel MUST close (and MUST NOT remain enabled) while the active tab is Home. Choosing Home from the panel MUST open or focus Home and close the panel.
- **FR-014**: The panel layout MUST follow the checked-in design mock's workspace panel (home control, brand wordmark, active-page address, member list, docked actions and chat) with Home's visual tokens, and MUST keep a distinct plan placeholder alongside actions and chat. Spacing MAY improve on the mock without inventing a separate visual system.

### Key Entities

- **Active page**: The browser tab currently in focus, including its live identity and address.
- **Workspace**: The durable named collection assigned to a page and shared with Home.
- **Saved tab reference**: A persisted page record that may remain in a workspace after its browser tab closes.
- **Other**: The state for a page without an assigned named workspace; not a synthetic workspace.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a walkthrough with named workspaces and Other, 100% of eligible active pages show the correct workspace or Other after opening the sidebar.
- **SC-002**: After a tab or window switch, the sidebar shows the new page's context within 2 seconds in at least 95% of local trials with the service available.
- **SC-003**: During 20 rapid tab switches, the sidebar never settles on a workspace belonging only to an earlier active page.
- **SC-004**: After closing and reopening the sidebar or browser, 100% of previously saved workspace names and member references remain available.
- **SC-005**: In a first-use walkthrough, users can identify the active workspace, a related page, and the three future tool areas without leaving the page.

## Assumptions

- Feature 003 supplies persistent workspace and tab membership for the paired person; feature 004 may already have assigned tabs, and feature 005/005b supplies Home.
- An unassigned eligible page is represented as Other. The sidebar does not run clustering automatically.
- The checked-in design mock's workspace panel guides layout and Home's styles guide color, type, and marks; the browser page itself remains outside the sidebar.
- Home is an extension page, not an eligible workspace host; disabling the Side Panel for that tab is the intended close behavior.
- Manual reassignment belongs to feature 007; live chat, plans, and actions belong to features 008–010.
