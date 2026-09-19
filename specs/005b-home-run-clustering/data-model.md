# Data Model: Home → run clustering

No new SQL tables. 005b is a **client view of an organization run** over existing 004/003 entities.

## Server (unchanged; owned by 004)

| Entity | Home use after organize |
| --- | --- |
| `ClusterRun` | Outcome of the POST; not listed on Home in this feature |
| `Workspace` | Appears as cards/tiles after refresh when applied |
| `TabRef` | Membership moves from Other (`workspaceId` null) into workspaces |
| `Suggestion` | May be returned in the POST body; **not** rendered as an inbox on Home (007+) |

## Client-only UI state

| Field | Values | Rules |
| --- | --- | --- |
| `organizeStatus` | `idle` \| `running` \| `failed` \| `empty` | `running` while fetch in flight; never invent directory rows |
| `organizeMessage` | short lowercase string | Failure / nothing-to-do / in-progress; cleared on next successful idle refresh optional |
| Directory | from existing `composeDirectory` | Reload via `loadDirectory` after successful run (`skipped: false` or whenever applied workspaces may have changed—always refresh on `200` except pure transport failure) |

## Validation / transitions

```text
idle --click--> running
running --200 applied or skipped--> idle (+ refresh on 200)
running --4xx/5xx/network--> failed (chrome intact)
failed --click--> running
running --409 run_in_progress--> failed or idle with “already organizing” (chrome intact)
```

## Out of scope entities

- No create-workspace from Home
- No local ClusterRun store
- No dummy furniture workspace names
