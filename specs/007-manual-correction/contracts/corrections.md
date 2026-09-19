# Corrections Contract

Feature 007 completes manual correction UX and Chrome projection on top of existing 003/004 HTTP. Auth remains `Authorization: Bearer <deviceToken>` for the paired person.

## Surfaces

| Surface | Can do | Cannot do |
| --- | --- | --- |
| Home | Drag tabs across workspaces/Other; rename workspace; create workspace (+ place a tab) | Replace the Side Panel |
| Side Panel | Move/recategorize **active** eligible page; dismiss an active-page suggestion | Browse/reorganize the full directory |
| Extension apply layer | Project membership onto Chrome tab groups after a successful save | Invent membership without a server write |

## Reused HTTP (authoritative)

Documented in `specs/003-workspace-persistence-api/contracts/http.md` and 004 suggestion routes:

| Action | Method | Effect |
| --- | --- | --- |
| List workspaces | `GET /api/workspaces` | Destinations for moves |
| Create workspace | `POST /api/workspaces` `{ name, emoji? }` | `201` workspace; `400` empty/long name |
| Rename workspace | `PATCH /api/workspaces/:id` `{ name }` | Updates label |
| Move tab | `PATCH /api/tab-refs/:id` `{ workspaceId: uuid \| null }` | Sets membership + `placementSource: "user"` + `corrections` row when changed |
| Resolve active page | `GET /api/resolve?chromeTabId=&url=` | Sidebar finds TabRef to PATCH |
| Dismiss suggestion | `POST /api/suggestions/:id/ignore` | `ignored`; no membership change |
| Organize (regression check) | `POST /api/cluster/runs` | Must not move `placementSource: "user"` tabs |

**Confirmed (T019):** Server apply paths in `apps/web/src/cluster/apply.ts` and candidate selection in `run.ts` only touch tabs where `workspace_id IS NULL AND placement_source IS NULL`. Covered by existing `apps/web/tests/cluster.test.ts` cases that assert user-placed tabs survive organize. No clustering reimplementation in the extension.

No new membership endpoint is required for MVP.

## Client write sequence

1. Optimistic UI optional; durable truth is the response body.
2. On success: update local directory/panel from returned `Workspace` / `TabRef`.
3. On API failure: leave prior membership visible; show quiet error.
4. Same-destination drag/move is a no-op (no correction row, no success toast that implies change).
5. Chrome tab-group projection is stretch **007b** (not part of this contract’s shipped surface).

## Chrome tab group sync

**Deferred (stretch 007b).** Not shipped in the MVP cut of 007. Manual membership changes update the server only; the extension does not call `chrome.tabs.group` / `tabGroups`. Revisit when two-way sync (Chrome group edits ↔ Home) is designed.

## Suggestion dismiss (sidebar)

When a pending suggestion targets the active page (or is shown in the panel):
- **Dismiss** → `POST .../ignore` → hide prompt; membership unchanged.
- Do not auto-accept in this feature’s MVP UI unless already present elsewhere.

## Privacy

- Only the paired user’s workspaces and tab refs.
- Never group or reassign `chrome-extension://`, `chrome://`, `file://`, or incognito tabs.
- Home tab itself is never a group member.

## Out of contract

- Training jobs consuming `corrections`.
- Persisting Chrome group ids in Postgres.
- Merge/archive workspace flows beyond existing PATCH status if already implemented.
- Computer-use or dragging tabs by pixel automation outside Chrome’s tabGroups/tabs APIs.
