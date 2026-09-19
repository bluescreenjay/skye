# Data Model: Chrome Sidebar — In-Tab Workspace

## Persistent records reused

This feature introduces no new tables or durable client records.

| Record | Fields used | Relationship and rule |
| --- | --- | --- |
| Workspace | id, name, emoji, status, userId | Same user-scoped workspace Home shows. Only active/saved, non-archived workspaces appear as named panel context. |
| TabRef | id, workspaceId, url, title, chromeTabId, placementSource | Related pages are all saved references in the resolved workspace, even if chromeTabId is null. A null workspaceId means Other. |
| User pairing | device token, server-derived user | All reads use the extension's configured token. No token or cross-user data appears in panel copy. |

## Ephemeral panel state

**Window context**: the browser window ID that owns this panel instance. It remains fixed during the instance's lifetime. Events from another window do not replace its view.

**Active page snapshot**: current tab ID, window ID, URL, eligibility, and a monotonically increasing request generation. A newer snapshot supersedes earlier in-flight reads.

**View state**:

| State | Data shown | Transition |
| --- | --- | --- |
| loading | Neutral title and progress copy; no previous workspace membership | Panel mounts or eligible active page changes |
| named | Resolved workspace and its saved TabRefs | Latest authenticated lookup returns a non-archived workspace |
| other | Other label and saved unassigned TabRefs | Latest lookup has no assigned workspace or no saved reference |
| unavailable | Neutral explanation; no previous workspace list | Active page is ineligible, pairing is missing, or the service fails |

## Validation and invariants

- The rendered state always belongs to the active eligible tab in this panel's window. Only the newest generation may commit a result.
- A workspace is displayed only if its ID matches the resolved TabRef's workspaceId and its status is not archived. A mismatch becomes unavailable, never an invented workspace.
- A related tab's URL must be HTTP or HTTPS before the panel offers an open action. Its saved reference may have no live Chrome tab ID.
- Other is a view state, not a Workspace row. Switching tabs, opening/closing the panel, and opening a related page do not modify assignment or placementSource.
- Unpaired and error states clear any previous workspace name and tab list before they can be mistaken for the active page's data.
