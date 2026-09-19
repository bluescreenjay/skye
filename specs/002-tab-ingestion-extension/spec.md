# Feature Specification: Tab Ingestion Extension

**Feature Branch**: `002-tab-ingestion-extension`

**Created**: 2026-09-19

**Status**: Implemented; manual validation in Chrome pending (see `quickstart.md`)

**Input**: User description: "Build the Chrome MV3 tab ingestion extension for AI Browser. The extension must list open tabs (URL, title), capture a short page snippet when possible, listen for tab lifecycle and active-tab changes, and continuously push tab snapshots to the workspace backend. Each change is an event in time, not only the latest tab list. It observes the browser only—it does not decide workspaces or run AI. Focus on reliable ingestion and sync, not clustering or the Home/Sidebar UIs."

## Clarifications

### Session 2026-09-19

- Q: Should this feature let the person pause tab reporting or exclude specific sites, or is the default exclusion of incognito windows and browser-internal pages the only privacy filter? → A: Defaults only. No pause switch and no site exclusion list in this feature; deferred to a later feature.
- Q: After the browser is closed and reopened and its tabs are restored, whose job is it to recognise that a restored tab is the same tab as before? → A: The backend's. The extension reports what it currently sees, including the browser tab id, plus a fresh snapshot after every start; the backend matches restored tabs to earlier records (for example by address).
- Q: If the backend stays unreachable for a long time, how much undelivered browsing activity should the extension hold on to before it starts discarding the oldest? → A: About 24 hours. Older events are dropped, the gap is noted, and a fresh snapshot is sent on reconnect.
- Q: How should the backend address and device token be set in this feature: baked in when the extension is built, or entered by the person in a settings screen inside the extension? → A: Set at build time from a config or environment file. No settings screen; switching targets means rebuilding.
- Q: How long should the extension wait for a tab to stop changing before it reports an update for it? → A: About 2 seconds after the tab's last change. Opens, closes, and activations are reported immediately.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Every open tab and every change reaches the backend (Priority: P1)

A person installs the extension and keeps browsing as usual. Without doing anything, the backend learns which tabs they have open (address and title) and hears about every tab that is opened, changed, or closed, each as a timestamped event. Nothing has to be organised or labelled by hand.

**Why this priority**: Every later feature (persistence, clustering, Home, Sidebar, "what was I working on yesterday?") starts from this signal. Without a trustworthy stream of tab state and tab events, there is nothing to organise.

**Independent Test**: Install the extension, open several tabs across more than one window, navigate in some, and close others. Inspect what the backend (or a stand-in receiver) received: the current tab set matches the browser, and a separate time-ordered event exists for each open, update, and close.

**Acceptance Scenarios**:

1. **Given** the extension is installed and some tabs are already open, **When** it starts, **Then** the backend receives a snapshot of every currently open tab with its address and title.
2. **Given** the extension is running, **When** the user opens a new tab, navigates an existing tab to a new page, or closes a tab, **Then** the backend receives an event for each of those changes with the time it happened.
3. **Given** a tab changed several times in a row, **When** the events are read back, **Then** they form a sequence in time (not only the latest state), so earlier states are not lost.

---

### User Story 2 - The active tab is always known (Priority: P1)

The person switches between tabs and windows. The backend always knows which tab is currently in front, and each switch is recorded as an event in time.

**Why this priority**: The in-tab workspace (Sidebar, feature 006) has to show the workspace of whichever tab the person is on, so it needs the active tab signal from the start, and "what was I working on yesterday?" depends on activation history.

**Independent Test**: Open three tabs and switch between them, including across two windows. The backend's record shows the active tab changing at each switch, in order, and at any moment identifies exactly one active tab for the focused window.

**Acceptance Scenarios**:

1. **Given** several tabs are open, **When** the user switches to a different tab, **Then** an activation event for that tab is recorded and the previous tab is no longer marked active.
2. **Given** two browser windows, **When** the user focuses the other window, **Then** the active tab of the newly focused window is reported as active.
3. **Given** the user closes the active tab, **When** the browser brings another tab forward, **Then** the newly active tab is reported.

---

### User Story 3 - A short page snippet is captured where possible (Priority: P2)

For each tab, the extension also sends a short excerpt of the page's readable text, so later features can tell what the page is about beyond its title and address. Where the page cannot be read, the tab is still reported without a snippet.

**Why this priority**: Clustering quality (feature 004) depends on snippets, but tabs are useful without them, so a tab must never be dropped just because its content could not be read.

**Independent Test**: Open a normal article page, a page that cannot be read (for example a browser settings page), and a page with almost no text. Verify the article has a short excerpt, and the other two are still reported with an empty snippet and no error surfaced to the user.

**Acceptance Scenarios**:

1. **Given** an ordinary web page has finished loading, **When** its snapshot is sent, **Then** it includes a short excerpt of readable text within the size limit, not the full page.
2. **Given** a page the extension is not permitted to read, **When** the tab is reported, **Then** it is sent with an empty snippet and its address and title.
3. **Given** a very long page, **When** the snippet is taken, **Then** it is cut to the size limit and never contains full page markup.

---

### User Story 4 - Sync survives interruptions without losing or duplicating events (Priority: P2)

The backend may be down, the network may drop, or Chrome may be closed and reopened. The extension keeps what it has not yet delivered, sends it when it can, and the backend ends up with the correct history: nothing missing, nothing counted twice.

**Why this priority**: The value of the event history depends on it being complete. "Reliable ingestion" is the stated focus of this feature.

**Independent Test**: Stop the backend, browse for a few minutes (open, navigate, close tabs), then restart the backend. Also close and reopen the browser while events are undelivered. Confirm that every event arrives exactly once and in order, and that the tab set matches the browser.

**Acceptance Scenarios**:

1. **Given** the backend is unreachable, **When** tabs change, **Then** the changes are kept and delivered, in order, once the backend is reachable again.
2. **Given** undelivered events exist, **When** the browser is closed and reopened, **Then** the undelivered events are still delivered and the extension sends a fresh snapshot to reconcile.
3. **Given** the same event is delivered more than once (for example after a retry), **When** the backend receives it, **Then** it can recognise the duplicate from a stable event identity and count it once.
4. **Given** the backend rejects the device's credentials, **When** the extension tries to send, **Then** it stops retrying that data in a tight loop and reports the problem state instead of silently dropping events.

---

### User Story 5 - The extension only observes (Priority: P2)

The extension reports what is happening in the browser and stops there. It does not group, move, rename, or close the person's tabs, does not decide workspaces, and does not run AI. It also does not report browsing that should stay private by default.

**Why this priority**: The constitution puts intelligence and decisions on the server and forbids clients inventing their own organisation. Sending private browsing to a server by default would break trust.

**Independent Test**: Use the browser normally with the extension for a session, including an incognito window and browser-internal pages. Confirm no tab was moved or grouped, no workspace concept appears anywhere in the extension, and nothing from the incognito window or internal pages reached the backend.

**Acceptance Scenarios**:

1. **Given** the extension is running, **When** the user browses, **Then** no tab is moved, grouped, renamed, or closed by the extension.
2. **Given** an incognito window, **When** tabs are opened or changed in it, **Then** nothing about them is captured or sent.
3. **Given** browser-internal or extension pages (for example the settings page), **When** they are open, **Then** they are not captured or sent.

---

### Edge Cases

- The extension is installed while tabs are already open: those tabs are sent as an initial snapshot (no browsing history is back-filled).
- Several rapid changes to one tab (redirects, loading updates, a title that keeps changing): they are coalesced into one update about 2 seconds after the last change, carrying the final state.
- A tab opens in the background and is never viewed: it is still reported.
- A tab is moved to another window or dragged out into a new one: it is still one tab, not a close plus an open.
- The browser restores a previous session on start: restored tabs are reported like any other tabs in the initial snapshot, with their new browser tab ids. The backend, not the extension, decides that they match earlier records.
- Two windows are open and focus alternates: exactly one tab per focused window is reported active.
- A page has no readable text, is a PDF, or is still loading: the tab is reported with an empty snippet, and a later update may add one.
- The backend is unreachable for more than 24 hours: events older than 24 hours are dropped oldest first, the gap is noted, and the fresh snapshot sent on reconnect repairs the tab list. Only the fine-grained history for the dropped window is lost.
- The device identity is missing or invalid: nothing is sent, and the problem is reported once rather than repeated for every event.
- Event timestamps and ordering: events from one browser are delivered in the order they happened.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: On start, the extension MUST send a snapshot of every reportable tab currently open, meaning web pages (`http:` or `https:`) in normal (non-incognito) windows, each with address, title, and its current browser tab id.
- **FR-002**: The extension MUST record a timestamped event for each tab being opened, updated (address or title change, loading complete), activated, and closed, and MUST keep them as a sequence in time, not only the latest state.
- **FR-003**: The extension MUST report which tab is active in the focused window, MUST record each activation as an event, and MUST report the newly active tab when the previous one closes or the focused window changes.
- **FR-004**: The extension MUST capture a short excerpt of a page's readable text when it can, within a fixed size limit consistent with the shared tab reference (about 2,000 characters), and MUST NOT send full page markup.
- **FR-005**: A tab whose content cannot be read or is not yet available MUST still be reported with an empty snippet; a missing snippet MUST NOT block or drop the tab or its events.
- **FR-006**: The extension MUST push snapshots and events to the workspace backend automatically and continuously while the browser is open, with no user action.
- **FR-007**: The extension MUST keep events it has not yet delivered, including across browser restarts, for at least the last 24 hours of activity, up to a cap of 20,000 events (several times a normal day), and MUST deliver them in the order they occurred once the backend is reachable. Events beyond either limit MAY be dropped, oldest first; when any are dropped the gap MUST be noted and a fresh snapshot sent on reconnect (FR-010).
- **FR-008**: Every event MUST carry a stable identity so that a retried delivery can be recognised and counted once by the backend.
- **FR-009**: The extension MUST coalesce bursts of changes to the same tab: it reports one update about 2 seconds after the tab's last change, carrying the tab's final state, so the backend is not flooded. Opens, closes, and activations MUST be reported immediately, without this wait.
- **FR-010**: The extension MUST send a fresh snapshot of all open tabs after startup and after a delivery gap, so the backend's view can be reconciled with the browser and can re-attach earlier tab records to the tabs that are live now (browser tab ids do not survive a restart).
- **FR-011**: Every delivery MUST identify the device's user via a device token, and if that identity is missing or rejected the extension MUST stop sending, MUST NOT drop buffered events silently, and MUST surface the problem state.
- **FR-012**: The backend address and device token MUST be set from configuration supplied when the extension is built, with no code changes and no settings screen, so the same source can target a local test receiver or a deployed backend by rebuilding.
- **FR-013**: The extension MUST NOT capture or send anything from incognito windows or from browser-internal and extension pages. These default exclusions are the only privacy filter in this feature: it has no pause control and no user-editable site exclusion list. Only `http` and `https` pages are reported; pages with other schemes (for example `file:` or `view-source:`) are treated like internal pages.
- **FR-014**: The extension MUST NOT move, group, rename, or close tabs, assign tabs to workspaces, or run AI. It only observes and reports.
- **FR-015**: The records it produces MUST conform to the shared tab reference and tab event definitions from feature 001, and MUST NOT introduce a second definition of them.
- **FR-016**: The extension MUST NOT provide Home, Sidebar, or any workspace UI. A minimal status indication for sync problems is allowed. There is no settings screen either (FR-012).
- **FR-017**: The extension MUST NOT try to decide whether a tab is the same tab as one from before a restart. It reports what it currently sees, and the backend decides whether it matches an earlier record.

### Key Entities *(include if feature involves data)*

- **Tab snapshot**: The current state of one open tab as the shared tab reference from feature 001 defines it: address, title, short snippet, browser tab identifier (valid only until the browser restarts), and last-seen time. Sent at start, after delivery gaps, and when a tab's state changes.
- **Full snapshot**: A snapshot that lists every reportable open tab, telling the backend that any of its records for this device that are not listed are no longer open. Sent at start and after a delivery gap.
- **Tab event**: One timestamped fact about a tab (opened, updated, activated, closed) as the shared tab event from feature 001 defines it, with a stable identity for de-duplication. Membership is not decided here, so the workspace field is left empty (Other).
- **Active-tab signal**: Which single tab is in front in the focused window at a given time, carried by activation events and by the snapshot.
- **Device identity**: The device token that ties everything the extension sends to one user. Issuing and pairing it is the job of feature 003.
- **Delivery backlog**: The ordered set of snapshots and events not yet acknowledged by the backend, kept across restarts until delivered or dropped under the retention bound.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Under normal connectivity, 95% of tab opens, navigations, activations, and closes are visible at the backend within 5 seconds of happening (this includes the short settling wait for updates).
- **SC-002**: Starting the extension with 100 tabs open delivers a complete snapshot of all of them within 15 seconds.
- **SC-003**: After the backend is unreachable for up to 10 minutes of normal browsing, 100% of the events that happened are delivered afterwards, in order, with zero duplicates counted.
- **SC-004**: After closing and reopening the browser with undelivered events, 100% of those events are still delivered.
- **SC-005**: Across a test session that includes an incognito window and browser-internal pages, 0 records from them reach the backend.
- **SC-006**: With the extension running and 100 tabs open, the person notices no slowdown in normal browsing.
- **SC-007**: 100% of records produced conform to the shared tab reference and tab event definitions (no divergent fields).
- **SC-008**: The extension moves, groups, renames, or closes 0 tabs, and contains no workspace-assignment or AI behavior.
- **SC-009**: After the backend has been unreachable for up to 24 hours of normal browsing, 100% of the events from that period are delivered afterwards, in order, with zero duplicates counted. For longer outages, everything from the most recent 24 hours is delivered and the tab list still matches the browser after the fresh snapshot.

## Assumptions

- Feature 001 is complete: the shared tab reference and tab event definitions and the environment layout exist and are the contract for what gets sent.
- The backend endpoint that receives this data is built in feature 003. Until then the extension is verified against a local stand-in receiver, so this feature is "done" when correct records reach a configurable address. Confirming they appear as durable records in the database is completed once feature 003 lands.
- Until pairing exists (feature 003), the device token is a manually supplied development value that the extension reads from its build-time configuration. That configuration is never committed (same rule as other secrets), and because the built extension contains the token, builds with a real token are for development use only.
- Hand-off to feature 003: the backend owns tab identity. It must match a reported tab to an existing record for that user (for example by address), refresh the stored browser tab id from each snapshot so later features can act on live tabs, and count a repeated event once by its event identity. Matching by address alone is imperfect (two tabs on one page, redirects), and that is for 003 to resolve.
- Only normal Chrome windows are observed. Incognito and browser-internal pages are excluded by default.
- A user-controlled exclusion list (for example for banking or email sites) and a pause control are out of scope for this feature and deferred to a later feature. Known limitation: until then, tabs on sensitive sites in normal windows are reported to the person's own backend like any other tab, and only the FR-013 default exclusions apply.
- The snippet is a short plain-text excerpt (about 2,000 characters, per feature 001), not full page content.
- Delivery keeps a bounded backlog of about 24 hours of activity so a long outage cannot grow storage without limit. One day of normal browsing is expected to be a few thousand small events. The 20,000-event cap sits well above a normal day; hitting it counts as the same gap as an age drop.
- The person is signed into Chrome on desktop. Other browsers and mobile are out of scope.
- Home, Sidebar, clustering, moving or grouping tabs, and AI are later features (005, 006, 004, 007).
