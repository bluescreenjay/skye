# Sidebar Contract

## Browser entry

- Extension manifest declares the sidePanel permission and a default local panel page.
- The person opens the extension from Chrome's side panel picker while a web page remains in the main browser area.
- The extension toolbar action continues to open Home in its own tab. The panel never replaces Home or embeds the web page.
- Choosing a saved page from Home focuses its live matching browser tab and opens this panel for that tab. If the saved tab is closed or stale, Home opens the saved URL in a new tab as a fallback.
- While the active tab is Home (or another ineligible page), the Side Panel is disabled for that tab so it closes and cannot stay open beside the directory. A Home control in the panel opens or focuses Home and closes the panel.
- This feature does not automatically open a panel outside a Home page selection, change the default new-tab page, or add a popup.

## Active-page context

On opening, the panel finds the active tab in its own normal browser window. It updates after tab activation, active-tab URL change, tab close/replacement, and relevant window focus change. A non-HTTP(S), incognito, or otherwise ineligible tab clears named context and shows unavailable. A newly eligible page starts in loading/Other until a current lookup completes.

Each request is tied to its window ID, tab ID, and generation. Only a result matching the newest active-page snapshot may update the UI. Late results from an earlier tab, page URL, or window are ignored.

## Existing server reads

All requests use the same Bearer device token as Home and ingestion.

1. Resolve the active page: GET /api/resolve?chromeTabId=<id>&url=<encoded-url>. Response: { workspace: Workspace | null, tabRef: TabRef | null }. Live tab ID takes precedence over URL on the server.
2. If the response has a non-archived workspace consistent with tabRef.workspaceId, read GET /api/tab-refs?workspaceId=<workspace-id>. Response: { tabRefs: TabRef[] }.
3. If unassigned or not yet saved, read GET /api/tab-refs?other=true only when showing related Other pages. The active page is labeled Other even if it has no saved reference yet.
4. An HTTP/auth failure or inconsistent/archived assignment results in unavailable, without showing the previous page's members.

The panel performs no write request. Existing 003 contracts remain unchanged.

## Visible view

Layout matches the design mock's workspace panel, using Home's accent/ink/type tokens with roomier padding than the mock: home control + skye wordmark, workspace title, read-only active-page address, scrollable member list, then a dock with plan placeholder, suggested-action chips, and chat shell.

| State | Header / title | Main list | Dock |
| --- | --- | --- | --- |
| loading | Loading context | Empty until current data arrives | Plan, actions, and chat placeholders |
| named | Workspace name and optional emoji | Saved members of that workspace | Same placeholders |
| other | Other | Saved unassigned pages | Same placeholders |
| unavailable | Clear quiet reason | No stale member rows | Same placeholders or disabled |

Long member lists scroll within the panel. A saved member with no live browser tab remains listed. Selecting an eligible member opens its saved URL in a normal tab and leaves the Side Panel as the in-tab surface. Placeholder controls do not claim to have generated a plan, executed an action, or answered a chat message.

## Privacy and ownership

Only normal-window HTTP(S) pages are eligible. Never surface a prior page's workspace on an internal, extension, file, or incognito page. Do not persist a second assignment map or include another user's data. The panel reads the same user-scoped records as Home.
