# Feature Specification: AI Clustering

**Feature Branch**: `004-ai-clustering`

**Created**: 2026-09-19

**Status**: Draft

**Input**: User description: "Add AI clustering that turns a messy set of open tabs into named workspaces. Use title, URL, and page snippet with the Gemini API—no vector database for MVP. High-confidence groups may be applied; low-confidence groups must become suggestions the user can accept or ignore. Never treat AI assignment as irreversible. Preserve an Other bucket for unrelated tabs. Clustering decisions live on the server; the extension only supplies tab signals and later applies assignments. Results will appear on Home (all workspaces) and in the sidebar (this tab's workspace)."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A messy tab set becomes named workspaces (Priority: P1)

A person has a pile of open tabs from several unrelated efforts (planning a trip, working on a project, reading about a hobby) and has not organized any of them. They ask the product to organize their tabs. Without labeling a single tab, they get back named workspaces (a name and an emoji each) that hold the tabs that belong together. Pages that fit nowhere stay in Other.

**Why this priority**: This is the product thesis ("tabs become workspaces"). Persistence (003) gives workspaces a home; this feature is what fills them. Without it, every workspace is built by hand and Home and the sidebar have little to show.

**Independent Test**: Load a known mixed set of tabs (for example 30 tabs: 10 about a trip, 10 about a coding project, 6 about cooking, 4 unrelated one-offs), all currently in Other. Run clustering. Three named workspaces exist, each holding mostly the tabs a person would put there, and the one-offs are still in Other. No tab was labeled by the user.

**Acceptance Scenarios**:

1. **Given** a user with several unorganized tabs on distinct topics, **When** clustering runs, **Then** each clear topic becomes a workspace with a short descriptive name and an emoji, containing that topic's tabs.
2. **Given** clustering finds a group it is confident about, **When** the run completes, **Then** the workspace is created and its tabs are assigned without further user action.
3. **Given** a tab that fits no group, **When** the run completes, **Then** it remains in Other and is not forced into a group.
4. **Given** a tab whose page text could not be read (empty excerpt), **When** clustering runs, **Then** it is still considered using its title and address, and is never dropped from the run.
5. **Given** the same tabs and no changes, **When** clustering runs again, **Then** no duplicate workspaces and no duplicate suggestions are created.

---

### User Story 2 - Uncertain groups become suggestions (Priority: P1)

When the system sees a plausible group but is not sure, it does not move anything. It offers a suggestion ("These 4 tabs look like *Kitchen Renovation*") that the user can accept or ignore. Accepting creates or fills the workspace; ignoring leaves everything as it was and stops asking about that same group.

**Why this priority**: The constitution requires low-confidence organization to suggest, not force. Silent wrong moves destroy trust faster than missing moves.

**Independent Test**: Run clustering on tabs where one topic is ambiguous (for example a few tabs that could be work or leisure). The ambiguous group appears as a pending suggestion, and none of its tabs changed workspace. Accepting it creates the workspace with those tabs. Ignoring another suggestion removes it from the pending list and it does not come back on the next run with the same tabs.

**Acceptance Scenarios**:

1. **Given** a proposed group below the confidence bar, **When** the run completes, **Then** a pending suggestion (proposed name, emoji, member tabs) is stored for the user and no tab changes workspace.
2. **Given** a pending suggestion, **When** the user accepts it, **Then** the workspace exists (or the existing one is used) and the tabs are assigned to it.
3. **Given** a pending suggestion, **When** the user ignores it, **Then** it leaves the pending list, nothing else changes, and the same group is neither suggested again nor auto-applied unless its tabs materially change.
4. **Given** a pending suggestion whose tabs have since been closed or moved by the user, **When** the pending list is read, **Then** the stale tabs are not offered (or the suggestion is withdrawn if too few remain).
5. **Given** no confident and no plausible groups, **When** the run completes, **Then** the result clearly says nothing was found, not an error.

---

### User Story 3 - Existing workspaces and Other are respected (Priority: P1)

A person already has workspaces, some made by hand. Clustering builds on them instead of fighting them. New tabs that clearly match an existing workspace join it rather than spawning a near-duplicate. Tabs the person placed themselves are never moved out. Archived workspaces are never targets.

**Why this priority**: A feature that reorganizes work the user already did would be worse than no feature. This is also what makes repeat runs safe as new tabs arrive.

**Independent Test**: Create a workspace "Trip to Japan" with two tabs by hand, and leave five more Japan-related tabs in Other. Run clustering. The five join "Trip to Japan" (no second Japan workspace appears), and the two manually placed tabs stay where they were. A tab manually placed in workspace A that looks like it belongs in B is left in A.

**Acceptance Scenarios**:

1. **Given** an existing active workspace and unplaced tabs that clearly match it, **When** clustering runs, **Then** those tabs are assigned to the existing workspace and no similarly named workspace is created.
2. **Given** a tab the user placed in a workspace (or deliberately left in Other after a correction), **When** clustering runs, **Then** its placement is unchanged.
3. **Given** an archived workspace, **When** clustering runs, **Then** no tab is assigned to it and no suggestion targets it.
4. **Given** a proposed new workspace name that matches an existing active workspace's name, **When** the group is applied, **Then** the tabs go to the existing workspace instead of creating a duplicate.
5. **Given** the reserved bucket Other, **When** clustering proposes a group, **Then** it is never named Other and never creates a workspace standing in for Other.

---

### User Story 4 - AI grouping is always reversible (Priority: P1)

Whatever the system applied, the user can take it back. They can undo a whole clustering run (all its assignments and the workspaces it created) or move a single AI-assigned tab out. A tab the user moves stays where they put it, even if a later run would have grouped it differently. The system remembers which placements were made by AI and which by the user.

**Why this priority**: The constitution's "User Corrections Win" principle. Irreversible AI grouping is the fastest way to lose trust, and it also protects every later feature (manual correction, learning) that depends on knowing who placed a tab.

**Independent Test**: Run clustering so it creates two workspaces and assigns tabs. Undo the run: the tabs return to where each was before (Other), and workspaces the run created (and that are still empty of user-added work) are archived. Run again, move one tab by hand, and run a third time: the hand-moved tab does not move.

**Acceptance Scenarios**:

1. **Given** a completed run that applied assignments, **When** the user undoes that run, **Then** every tab it moved returns to its prior workspace (or Other), and workspaces it created that no longer hold anything the user added are archived.
2. **Given** an AI-assigned tab, **When** the user moves it to another workspace or Other, **Then** the new placement is recorded as a user decision that later runs do not override.
3. **Given** a workspace created by a run that the user has since added their own tabs to or renamed, **When** the run is undone, **Then** the user's work is kept: only the AI's assignments are reverted, and the workspace stays.
4. **Given** every placement, **When** a client reads it, **Then** it can tell whether the placement was made by AI or by the user.
5. **Given** a suggestion dismissal or an undo, **When** it happens, **Then** it is recorded as a signal for future organization, without changing this run's behavior.

---

### User Story 5 - Home and the sidebar can read the results (Priority: P2)

Home shows every workspace and any pending suggestions. The sidebar, on a given tab, asks which workspace that tab is in and whether the AI put it there. The extension supplies tab signals and reads back assignments to apply; it never decides them. This feature provides the server-side results those surfaces will read; it does not build the surfaces.

**Why this priority**: Results are only valuable if the two product surfaces can consume them, but the surfaces themselves are later features (005, 006). The reading side can ship after the core loop works.

**Independent Test**: After a run, a Home-like client lists workspaces, their tabs, and pending suggestions; a sidebar-like client resolves a specific tab to its workspace and sees that it was AI-assigned; a different user sees none of it.

**Acceptance Scenarios**:

1. **Given** a completed run, **When** a Home-like client requests the user's workspaces and pending suggestions, **Then** both come back together with their tab membership.
2. **Given** a tab assigned by the AI, **When** a sidebar-like client resolves that tab, **Then** it gets the workspace and an indication that the placement is AI-made (and reversible).
3. **Given** two different users, **When** each reads results, **Then** neither sees the other's workspaces, suggestions, or run history.
4. **Given** no valid pairing, **When** a client tries to run clustering or read results, **Then** the request is rejected.

---

### Edge Cases

- **Too few tabs**: with fewer tabs than can form a group, clustering finishes with no groups and no error; everything stays where it was.
- **Very many tabs**: a run considers a bounded number of the most recently seen unplaced tabs; the rest stay in Other and the result says how many were left out.
- **AI service unavailable, slow, or over quota**: the run fails cleanly with a clear message; nothing is changed, and running again is safe. Hackathon-day outages must not block the manual path (003).
- **Unusable AI answer** (malformed, empty, or naming tabs that do not exist): invalid groups are discarded; valid groups in the same answer may still proceed; if nothing is usable, nothing changes.
- **A tab proposed for two groups**: it ends up in at most one (the more confident one), or stays in Other.
- **A tab changes while the run is in flight** (user moves or closes it): the user's change wins; the system does not assign a tab that is no longer where it was when analyzed.
- **Two runs at once for the same user**: only one runs at a time; the second waits or is refused, never interleaves.
- **Nothing new since the last run**: the system does not call the AI service again when no unplaced tab was added or changed and no active workspace was created, renamed, or archived, so repeated triggers do not cost anything.
- **Group of one**: a single tab is never turned into a workspace on its own.
- **Sensitive pages**: a normal-window page on a sensitive site is sent to the AI service like any other page (same known limitation as the extension's, no exclusion list in this feature). Incognito and browser-internal pages never reach this feature because ingestion excludes them.
- **Blank or generic names**: a proposed name that is empty, over the length limit, or meaningless ("Group 1") is replaced by a usable name or the group falls back to a suggestion.
- **Cross-user data**: one user's tabs never appear in another user's analysis, suggestions, or results.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST, on request, analyze the requesting user's stored tabs using each tab's title, address, and page excerpt, and propose groups of related tabs with a name and an emoji for each group.
- **FR-002**: Clustering decisions MUST be made on the server. Clients MUST only supply tab signals and request a run; they MUST NOT decide groups.
- **FR-003**: Each proposed group MUST carry a confidence. A group at or above the confidence bar MUST be applied (workspace created or reused, tabs assigned); a group below it MUST be stored as a pending suggestion and MUST NOT move any tab.
- **FR-004**: A pending suggestion MUST be acceptable (applies the group) or ignorable (dismisses it), and an ignored suggestion MUST NOT be re-offered, and its group MUST NOT be auto-applied at any confidence, unless its tabs materially change.
- **FR-005**: Tabs that fit no group MUST remain in Other. The system MUST NOT force every tab into a workspace, and a group MUST have at least two tabs.
- **FR-006**: The system MUST NOT move a tab that the user placed (or deliberately kept in Other via a correction) and MUST NOT assign tabs to, or suggest, an archived workspace.
- **FR-007**: The system MUST prefer an existing active workspace over creating a near-duplicate: a group whose name matches an active workspace, or whose tabs clearly match it, MUST go to that workspace.
- **FR-008**: A proposed workspace MUST NOT be named Other and MUST have a name within the workspace name limits (1–80 characters).
- **FR-009**: Every placement MUST record whether it was made by AI or by the user. A user placement MUST take precedence over AI placement in every later run.
- **FR-010**: Every applied run MUST be recorded as a unit that the user can undo. Undoing MUST restore each tab it moved to its prior placement, and MUST archive any workspace the run created that holds nothing the user added, while keeping anything the user added or renamed.
- **FR-011**: Dismissals, undos, and moves of AI-placed tabs MUST be recorded as correction signals for future organization. This feature MUST NOT change its own grouping behavior based on them.
- **FR-012**: A group MUST NOT be applied to a tab whose placement changed between analysis and apply; the user's change wins.
- **FR-013**: The system MUST handle an unavailable, slow, or invalid AI response without changing any tab or workspace, and MUST report a clear failure the client can show. Retrying MUST be safe.
- **FR-014**: The system MUST NOT run two clustering runs for the same user at once, and MUST NOT call the AI service when no unplaced tab has been added or changed and no active workspace has been created, renamed, or archived since the last successful run, unless the caller explicitly forces a run.
- **FR-015**: A run MUST consider a bounded number of tabs (most recently seen first) and MUST report how many were left out.
- **FR-016**: Clients (Home-like and sidebar-like) MUST be able to read, for the authenticated user only: workspaces with their tabs, pending suggestions, run history, and for any tab whether its placement was made by AI or by the user.
- **FR-017**: Every request MUST be authenticated by the device pairing token and every read and write MUST be user-scoped. The system MUST NOT include one user's tabs in another user's analysis or results.
- **FR-018**: The system MUST NOT store or send anything beyond what clustering needs (title, address, capped excerpt, and existing workspace names) to the AI service, MUST NOT log page excerpts, and MUST NOT commit or expose the AI service key.
- **FR-019**: This feature MUST NOT implement embeddings or a vector store, learning from corrections, the Home UI, the sidebar UI, moving or grouping tabs in the browser, chat, plans, actions, or the command bar. Those features MAY consume this feature's results later.

### Key Entities

- **Clustering run**: One execution for a user: when it ran, how many tabs it considered and left out, its outcome (applied, suggested, nothing found, failed), and the placements it made. The unit the user can undo.
- **Proposed group**: A candidate set of related tabs with a name, an emoji, and a confidence. Becomes either applied placements or a suggestion.
- **Suggestion**: A stored, user-facing proposal ("these tabs look like X") that is pending, accepted, or ignored. Never moves a tab until accepted.
- **Placement origin** (stored as the placement source): Whether a tab's current workspace (or Other) was set by AI or by the user. An *unplaced* tab is one in Other that neither the user nor a run has placed. Drives what later runs may touch.
- **Workspace**, **Tab reference**, **User**: Existing entities from features 001 and 003; clustering creates and fills workspaces and reads tab references but does not change their identity.
- **Correction signal**: A recorded dismissal, undo, or user move of an AI placement, kept for later learning (feature 007 and beyond).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a reference set of at least 30 mixed unorganized tabs covering at least three distinct topics plus a few unrelated one-offs, a single run leaves at least 80% of the tabs in the workspace a person hand-labeling them would choose, or in Other for the one-offs, with no user labeling required.
- **SC-002**: On the same reference set, 100% of the tabs placed by an unattended (auto-applied) group were reachable by the user through a single undo, and undoing a run restores 100% of moved tabs to their previous placement.
- **SC-003**: 0% of tabs the user placed by hand (or kept in Other by correction) are moved by any run, across at least five consecutive runs with new tabs added between them.
- **SC-004**: 0% of below-confidence groups change any tab's workspace; each appears as a pending suggestion that can be accepted or ignored, and accepting works on the first attempt.
- **SC-005**: Running clustering twice in a row on unchanged tabs creates 0 duplicate workspaces and 0 duplicate suggestions, and the second run makes no AI call.
- **SC-006**: For a set of up to 50 tabs, a run returns its result within 30 seconds for at least 90% of runs.
- **SC-007**: With the AI service unavailable, a run leaves 100% of workspaces and tab placements unchanged, and the user still sees a clear failure message.
- **SC-008**: In a two-user check, 0% of one user's tabs, workspaces, suggestions, or runs appear in the other's analysis or results.
- **SC-009**: After a run, a Home-like client and a sidebar-like client can each retrieve the results (workspaces with tabs and pending suggestions; a tab's workspace and whether the AI placed it) in one round trip each, and both agree on the same workspace identifiers.
- **SC-010**: This feature ships with no Home or sidebar screens and no tab moving in the browser; success is "the server organizes tabs sensibly and reversibly," not a browser demo.

## Assumptions

- Features 001 (shared model), 002 (tab ingestion), and 003 (workspace persistence and receiving 002's tab feed) exist. Stored tab references, workspaces, the Other bucket, and pairing already work; clustering builds on them.
- The AI model service is configurable behind one interface. The default is the Virginia Tech ARC LLM API and Google Gemini is the selectable backup (research section 19); clustering's observable behavior and this spec do not change under a provider swap. No vector store or embeddings are used.
- Clustering runs **on request** (a client or the user triggers it). Automatic triggering as new tabs arrive is a later, additive step; this feature keeps a run cheap and safe to repeat so that step is easy. Home's "Organize my tabs" and similar controls are feature 005.
- "Confidence" is a single system-defined bar per run (one tunable value). Its exact number is a planning decision; the behavior above holds for any value.
- Only unplaced tabs are candidates for grouping: tabs in Other that neither the user nor a previous run has placed (a tab the user deliberately left in Other is excluded). Tabs already in a workspace are never re-evaluated in this feature (re-organizing across workspaces is feature 007, manual correction).
- Each placement change made by a run, a suggestion accept, or an undo is also written to the tab event history as a reassignment.
- Accepting a suggestion is the user's own placement: it is not part of a run and is not undone by undoing a run. The user can move tabs individually through the existing workspace features.
- A group needs at least two tabs, and a run considers at most a bounded number of tabs (a planning decision, on the order of a hundred).
- Whether the placement was made by AI or the user is a new durable fact about a tab reference. Suggestions and runs are new durable records. Their storage design belongs in the plan and MAY extend the feature 001 schema; that extension MUST stay user-scoped and MUST keep the shared types in sync.
- There is no per-site exclusion list yet. A page on a sensitive site in a normal window is sent to the AI service the same as any other page. This mirrors the known limitation of feature 002 and is called out for a later feature.
- The AI service key lives in server configuration only and is never sent to the extension or committed.
- Applying assignments in the browser (moving or grouping tabs) is a later extension feature (007). Here, "apply" means recording the assignment on the server.
- No open clarification questions remain: run trigger, confidence handling, scope of candidate tabs, undo semantics, and out-of-scope boundaries are decided above and can be revisited in `/speckit-clarify`.
