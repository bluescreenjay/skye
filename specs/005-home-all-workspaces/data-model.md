# Data Model: Home — all workspaces

Canonical types: `@ai-browser/shared` (`Workspace`, `TabRef`). No new SQL tables. Home is a **view model** over 003 rows.

## Loaded from the API

### Workspace (card + rail tile)

| Field | Home use |
| --- | --- |
| `id` | Identity; PATCH target |
| `name` | Editable card title; lowercase |
| `status` | Default list: omit `archived` |
| `emoji` | Unused on Home (mock has no emoji on cards) |

All non-archived workspaces appear as **cards** and as **rail tiles** (up to four tab marks per tile). 003 `saved` vs `active` is not a separate Home chrome in this feature.

### TabRef

| Field | Home use |
| --- | --- |
| `id` | Drag/PATCH target |
| `workspaceId` | `null` → Other (rail-top icons); uuid → member of that card |
| `url` | Open in a browser tab on click |
| `title` | Tab row label (lowercase) |
| `chromeTabId` | Live binding: Home lists the tab only when non-null (see clarifications/live-home-tabs.md). Not used as durable identity (still user+url). |

### Other

Not a workspace row. The set of tab refs with `workspaceId == null`.

## Client-only (not persisted)

| Concept | Rule |
| --- | --- |
| `expandedId` | At most one workspace id; accordion |
| Greeting weather phrase | From location + Open-Meteo; fallback `"hard to tell"` |
| Greeting time | Local clock |
| Artifact / action / ask UI | Stub regions; dummy local chat in the mock is **not** required to persist (008) |
| Drag session | Ignore the following click |

## Validation (reuse 003)

- Rename: 1–80 characters after trim; store lowercase to match Home copy.
- Move: `workspaceId` must be this user’s workspace or `null`.
- No create workspace from Home.
- Do not insert mock seed workspaces.

## State transitions (UI)

- Collapsed card → click body → expanded (previous expanded collapses).
- Expanded → click header body → collapsed.
- Tab drag → membership PATCH → re-render from server (or optimistic then reconcile).
- Tab click → new browser tab with `url`; Home unchanged.
