# Research: Chrome Sidebar — In-Tab Workspace

## Side Panel entry and toolbar behavior

**Decision**: Declare a default Side Panel page and the sidePanel permission. Users open it from Chrome's side panel picker. Keep the existing toolbar click dedicated to Home.

**Rationale**: Chrome supports a default panel page that stays alongside the web page. Its open-on-action-click behavior would replace the current toolbar action, which 005 owns. A default panel avoids that conflict and lets the panel remain available across eligible tabs. Target Chrome 116+ for a consistent Side Panel baseline.

**Alternatives considered**: Reassign the toolbar action to the panel (breaks 005); open a tab-specific panel for every tab (separate instances and unnecessary lifecycle complexity); put the workspace in Home (violates the two-surface design).

**Source**: [Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).

## Active page and window scope

**Decision**: Each panel instance captures its containing normal browser window, then queries that window's active tab on mount and on relevant tab activation, URL update, removal/replacement, and focus changes. Discard responses whose request generation or tab identity no longer matches.

**Rationale**: Chrome's "current window" can differ from the focused window. Using one fixed window per panel prevents a second window's events from replacing the first panel's context. The generation guard handles network responses arriving out of order. A temporary no-focus signal does not by itself clear valid context.

**Alternatives considered**: Global last-focused lookup for every panel (cross-window leakage); only listen to tab activation (misses navigation in the active tab); service-worker memory as the source of truth (lost when the worker sleeps).

**Sources**: [Chrome Windows API](https://developer.chrome.com/docs/extensions/reference/api/windows), [Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs).

## Eligibility and identity

**Decision**: Reuse the extension's existing web-page eligibility rule: normal-window HTTP or HTTPS tabs only. Resolve a saved reference using live Chrome tab ID plus URL, allowing the existing server to prefer live identity and fall back to the latest matching URL. Never carry the old workspace into an ineligible page.

**Rationale**: The extension already excludes incognito and non-web pages. The 003 resolution contract explicitly prefers live tab ID, which matters when saved references share a URL. A page not yet ingested is a temporary Other view, not a new client-created workspace.

**Alternatives considered**: URL-only matching (can choose another saved copy); creating a workspace/reference in the panel (wrong authority and side effects); showing the previous workspace while loading (misleading).

**Sources**: specs/003-workspace-persistence-api/contracts/http.md; apps/extension/src/filters.ts.

## Data reads and related-page action

**Decision**: Use the existing authenticated resolve read, followed by the existing tab-reference list filtered to that workspace or Other. Opening a related saved page creates a normal browser tab using its saved URL; do not change membership.

**Rationale**: The durable list already includes closed browser tabs. Opening a new tab avoids relying on a possibly stale Chrome tab ID and matches Home's existing tab-link behavior. No backend contract or migration is needed.

**Alternatives considered**: New combined endpoint (unnecessary for the MVP); reuse cached Home directory state (not available in the panel and can be stale); activate a stored live tab ID (can now refer to another page).

**Sources**: specs/003-workspace-persistence-api/contracts/http.md; apps/web/app/api/resolve/route.ts; apps/web/app/api/tab-refs/route.ts.

## UI scope and validation

**Decision**: Use the workspace-panel portion of the checked-in mock for visual continuity, adapted to the actual narrow Chrome Side Panel. Show named workspace or Other, related tabs, and explicit empty plan, action, and chat areas. Verify state selection and stale-response handling with Vitest; validate layout and browser events in Chrome.

**Rationale**: The mock's page frame belongs to the real browser page, not to panel HTML. Later features 008–010 own live assistant behavior. The current test harness cannot fully simulate Chrome's native panel lifecycle.

**Alternatives considered**: Copying the full mock into the side panel (duplicates the page); fake assistant outputs (misrepresent capability); exhaustive rendering tests that duplicate markup.

**Sources**: specs/005-home-all-workspaces/mocks/home-design-prototype/; [Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).
