# Data Model: Manual Workspace Correction

**Branch**: 007-manual-correction | **Date**: 2026-09-19

## Durable entities (existing)

### Workspace

Owned by `user_id`. Fields used by this feature: `id`, `name`, `emoji`, `status` (`active` for correction targets). Created via Home create; renamed via Home rename. Archived workspaces are not assignment destinations.

### TabRef

Durable page membership. Fields: `id`, `userId`, `workspaceId` (`null` = Other), `url`, `title`, `chromeTabId`, `placementSource` (`null` | `ai` | `user`).

**Rules**:
- Any successful manual membership write sets `placementSource` to `user` (including deliberate Other).
- Clustering may only place tabs where `workspaceId IS NULL` and `placementSource IS NULL`.
- Closed browser tabs keep their `TabRef`; `chromeTabId` may be null — still movable on Home; omitted from Chrome group sync.

### Correction

User-scoped feedback for a membership override (already in `corrections`):

| Field | Meaning |
| --- | --- |
| `id` | Stable id |
| `userId` | Acting person |
| `fromWorkspaceId` | Previous workspace or null (Other) |
| `toWorkspaceId` | New workspace or null (Other) |
| `tabRefId` | Affected tab reference (nullable if ref deleted later) |
| `url` | Page address snapshot |
| `createdAt` | When recorded |

Inserted when membership actually changes. Same-destination no-ops do not insert.

### Suggestion

Soft clustering proposal. Dismiss sets `status` to `ignored` (existing). That row is the dismiss feedback signal for FR-009.

**Feedback sources (007, no training pipeline):**
- Membership moves → `corrections` insert via PATCH/PUT tab-refs (003/004).
- Suggestion dismiss → `suggestions.status = ignored` via `POST /api/suggestions/:id/ignore`.
- No export job, dataset builder, or model update in this feature.

## Chrome projection (ephemeral)

### TabGroupProjection

Not stored in Postgres. Derived per browser window after a successful correction or directory refresh:

| Field | Meaning |
| --- | --- |
| `workspaceId` | Durable workspace being projected |
| `chromeGroupId` | Session-only Chrome group id |
| `title` | Workspace name (truncated to Chrome’s limit) |
| `tabIds` | Open eligible `chromeTabId`s for that workspace in the window |

**Rules**:
- Recompute from current TabRefs + live tabs; never trust a stale `chromeGroupId` across sessions.
- Other / unassigned open tabs are ungrouped.
- Ineligible tabs are never grouped.

## State transitions

```text
TabRef.placementSource:
  null  --(manual move/create-assign)--> user
  ai    --(manual move)--> user
  user  --(manual move again)--> user
  *     --(clustering apply)--> unchanged if not (null workspace AND null placement)
```

```text
Suggestion.status:
  pending --(ignore)--> ignored
  pending --(accept)--> accepted (membership becomes user-placed; out of core 007 UI unless already wired)
```

```text
Chrome groups:
  (none) --(sync after save)--> named groups matching workspaces
  groups --(sync)--> rebuilt to match membership
```

## Validation

- Workspace name: 1–80 characters after trim (server enforced).
- Assignment target: workspace must belong to the same user and not be archived; or null for Other.
- Sidebar move: only the active eligible page’s TabRef.
- Group sync: only normal-window HTTP(S) tabs with a live `chromeTabId` on a TabRef.

## Out of model for this feature

- ML training datasets or weight updates.
- Persisted Chrome `groupId` on workspaces.
- Merge-workspace entity.
- Bulk multi-select correction sessions.
