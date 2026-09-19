# Research: Manual Workspace Correction

**Branch**: 007-manual-correction | **Date**: 2026-09-19

## 1. Membership writes and “manual wins”

**Decision**: Reuse `PATCH /api/tab-refs/:id` and `PUT /api/tab-refs` with `workspaceId` set (including `null` for Other). Those routes already set `placementSource: "user"` and call `recordCorrection`. Clustering `applyGroups` only updates rows where `workspace_id IS NULL AND placement_source IS NULL`, so user-placed tabs are left alone on the next organize.

**Rationale**: Spec FR-006/FR-007 are already mostly satisfied server-side (003 + 004). Feature 007’s gap is product UI completeness and Chrome projection, not a new assignment algorithm.

**Alternatives considered**:
- New `/api/corrections` write API — rejected; duplicates PATCH semantics.
- Client-only membership map — rejected (constitution II / FR-011).

## 2. Home create / rename / drag

**Decision**: Keep existing Home drag → `moveTab` and rename → `renameWorkspace`. Add an explicit **create workspace** control that `POST /api/workspaces` then optionally moves a dragged/selected tab into it via PATCH. Reject empty names using existing 400 from the API.

**Rationale**: FEATURES and the spec require create; API already exists. Drag/rename shipped with 005 and need polish/error surfacing where silent failures remain.

**Alternatives considered**:
- Create-only via accepting a clustering suggestion — rejected; user must create without waiting for AI.
- Merge workspaces in this feature — rejected (spec assumptions).

## 3. Sidebar active-tab move

**Decision**: Sidebar lists the person’s active workspaces (from `GET /api/workspaces`) plus Other. Choosing a destination PATCHes the active page’s `tabRef` (from resolve). On success, refresh panel view; on failure, keep previous view and show quiet error (FR-010). Do not navigate away from the page.

**Rationale**: Spec US2 limits sidebar to the active page; Home remains the directory.

**Alternatives considered**:
- Full drag of all members inside the sidebar — rejected for MVP scope.
- Embedding Home directory in the panel — rejected (Principle VII).

## 4. Suggestion dismiss

**Decision**: Wire UI to existing `POST /api/suggestions/:id/ignore`. Dismissed suggestions stay `ignored` and clustering already refuses to auto-apply an ignored look-alike group. No membership change.

**Rationale**: Satisfies FR-005 and FR-009 dismiss feedback without a new table.

**Alternatives considered**:
- Delete suggestion rows — rejected; lose “do not re-offer” signal.
- Insert a `corrections` row for every dismiss — optional later; ignored status is sufficient for MVP.

## 5. Correction records for create / rename

**Decision**: Tab moves continue to insert into `corrections` (existing). Workspace create/rename are durable on `workspaces` and do not require ML training data in MVP; if a uniform audit is needed, add an optional `kind` column in a small `007` SQL migration (`reassign` | `create_workspace` | `rename_workspace` | `dismiss_suggestion`). Default plan: **no migration** unless tasks discover a consumer that needs those rows.

**Rationale**: Spec allows feedback signals without a training pipeline; over-modeling slows the demo.

**Alternatives considered**:
- Always extend schema in this feature — deferred unless a checklist requires it.
- Skip all correction rows — rejected; moves already record and tests assert them.

## 6. Chrome tab organization

**Decision**: After a successful membership change (and on a lightweight post-ingest / post-Home-refresh hook), reconcile open eligible tabs in each normal window:
1. Collect open tabs with known `chromeTabId` on saved refs that have a named `workspaceId`.
2. `chrome.tabs.group({ tabIds })` per workspace (reuse existing group id when already correct).
3. `chrome.tabGroups.update(groupId, { title: workspace.name, collapsed: false, color })` with a stable color from a small fixed palette derived from workspace id.
4. Ungroup open tabs that belong to Other or have no assignment.
5. Never touch incognito, non-HTTP(S), or extension pages (including Home).

Manifest adds `"tabGroups"` permission. Implementation lives in `apps/extension/src/apply-groups.ts` (and callers from Home/Sidebar/background), **not** in ingest modules. Update `observe-only` tests to allowlist that module the same way as `sidepanel-gate.ts`.

**Rationale**: Native tab groups are the clearest Chrome-native projection; constitution II expects the extension to apply assignments. Group ids are session-ephemeral—recompute from membership, never persist group ids as durable keys.

**Alternatives considered**:
- Only rename window titles — weaker than groups; rejected.
- Persist `groupId` on workspaces — rejected; Chrome reuses/changes ids across sessions.
- Require `"tabs"` permission broadly — avoid if host permissions + known tab ids suffice for group/ungroup; request only if walkthrough proves otherwise.

## 7. Failure and sync ordering

**Decision**: Persist first (server PATCH/POST), then apply Chrome groups. If persist fails, do not change groups and show quiet failure. If persist succeeds and groups fail, keep durable membership and surface a non-blocking note that browser groups could not update (FR-010).

**Rationale**: Server is source of truth; Chrome is a best-effort projection.

**Alternatives considered**:
- Groups first — rejected; would diverge from server on API failure.
- Transactional rollback of PATCH if groups fail — rejected; Chrome is not durable product state.

## 8. Dependencies / unknowns resolved

| Topic | Resolution |
| --- | --- |
| Does 004 honor user placement? | Yes — candidates and apply filters exclude `placement_source` not null. |
| Do PATCH routes write corrections? | Yes — `recordCorrection` on membership change. |
| Create workspace API? | Yes — `POST /api/workspaces`. |
| Dismiss API? | Yes — `POST /api/suggestions/:id/ignore`. |
| Chrome API? | `tabs.group` + `tabGroups.update` with `tabGroups` permission. |
