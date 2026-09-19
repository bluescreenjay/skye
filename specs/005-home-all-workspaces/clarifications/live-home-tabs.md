# Clarification: Live tabs on Home + close control

**Date**: 2026-09-19  
**Feature**: 005 Home — all workspaces (UX delta; does not open a new Spec Kit feature number)  
**Status**: Accepted for implementation

## Decisions

### A — Home lists live-bound tabs only

Home MUST show a TabRef in Other (rail), card header icons, and the expanded tab column **only when** `chromeTabId != null`.

- Backend `tab_refs` rows remain durable: closing a browser tab still only clears `chromeTabId` via ingest (002/003). No DELETE.
- Empty named workspace cards still appear (unchanged 005 rule).
- After browser restart, marks reappear once ingest rebinds open tabs.

This narrows 005’s earlier reading that Home shows every saved member regardless of live binding, and updates the 005 data-model note that `chromeTabId` was unused for Home: it now gates **visibility** on Home only.

Sidebar (006 FR-003) continues to list saved members including closed pages.

### B — Close control on expanded rows

Expanded Home tab rows MUST offer a right-side close control that closes the matching live Chrome tab (`chrome.tabs.remove` after the same live-id + URL checks as open/focus).

- Close MUST NOT also open/navigate the tab.
- Other rail icons and collapsed header icons need not offer an X in this delta; they still disappear when the live tab closes (filter + `onRemoved` / refresh).

### C — Interaction with 007 (manual correction)

While Home hides closed TabRefs, those pages cannot be dragged on Home. Reassignment of a closed page remains available from the Sidebar (active page) or a later “show saved” mode. This is an accepted tradeoff for this UX.

## Non-goals

- Deleting TabRefs from the API or SQL
- Changing Sidebar closed-tab listing
- Feature 010 agents / schemas
- Preemptive ghost-row suppression sets (prefer existing refresh + `onRemoved`; add scoped suppression only if ghosts reproduce)
