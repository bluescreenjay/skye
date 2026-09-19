# Quickstart: Validate the In-Tab Sidebar

Use this guide after feature 006 is implemented. It validates [the sidebar contract](contracts/sidebar.md) against the existing saved workspace data.

## Prerequisites

- Node.js 22+, pnpm 9, Chrome 116+.
- The 003 database schema and 004 clustering schema are applied. Root .env has DATABASE_URL and DEVICE_TOKEN_SECRET. The server need not call an AI provider for this feature.
- apps/extension/.env has VITE_API_BASE_URL pointing at the server and VITE_DEVICE_TOKEN set to the same paired device token used for Home/ingestion. Do not share the built extension: the token is embedded in its output.
- At least two non-archived named workspaces with saved tabs and one Other tab. Use Home/005b Organize or the setup examples in specs/003-workspace-persistence-api/quickstart.md.

## Build and run

~~~bash
pnpm install
pnpm typecheck
pnpm --filter @ai-browser/extension test
pnpm --filter @ai-browser/web test
pnpm --filter @ai-browser/web dev
pnpm --filter @ai-browser/extension build
~~~

Load apps/extension/dist as an unpacked extension in chrome://extensions, then reload it after each rebuild. Keep Home available through the toolbar action. Open an ordinary HTTP(S) page from a saved workspace and select the AI Browser entry in Chrome's side panel picker.

## Walkthrough

1. **Named workspace**: Open the panel beside a page assigned to workspace A. Expect A's name and its saved related tabs, including a member whose original browser tab was closed. The web page remains visible and usable. The toolbar still opens Home.
2. **Home link**: From Home, choose a saved page that remains open in Chrome. Expect Chrome to focus that existing tab and automatically open Skye in the Side Panel for it; Home does not create a duplicate tab. Close that browser tab and choose it from Home again; expect the saved URL to open in a new tab as a fallback.
3. **Close on Home**: With the panel open on a web page, activate the Home tab (or press **home** in the panel). Expect the Side Panel to close and stay closed while Home is active. Returning to a web page makes the panel available again without opening it automatically.
4. **Related link**: Choose a saved related page from the panel. Expect its address to open in a normal browser tab while the panel remains the sidebar, not the Home directory. The workspace assignment is unchanged.
5. **Other**: Activate an unassigned web tab. Expect an Other label and no workspace A member list. A newly opened eligible page with no saved reference must not inherit A.
6. **Retarget**: With the panel open, alternate between workspace A, workspace B, and Other. Expect the correct label and member list within 2 seconds of each switch when the local API is available.
7. **Rapid switches**: Switch tabs at least 20 times, including while API reads are in flight. Expect no settled display from an older tab after the newest selection finishes.
8. **Second window**: Open another normal Chrome window on a different workspace and open its panel. Switch window focus and tabs. Each panel must continue to show the active page for its own window, never the other window's workspace.
9. **Unavailable**: Switch to chrome://extensions or a local file, then back to a web page. Expect a neutral unavailable state on the ineligible page and a fresh correct context on return. Repeat with the server stopped or the token invalid; expect a clear failure and no prior workspace list.
10. **Persistence**: Close and reopen the panel, then restart Chrome. The workspace name and saved related tabs should return unchanged. No extra workspace or reassignment should appear in Home.
11. **Future tools**: Find separate plan, suggested action, and chat regions in the dock. Placeholder interactions must not claim that a real result was produced.

## Completion checks

- The built extension contains a distinct panel page alongside Home.
- The panel uses real paired-user records only; no mock projects appear.
- The 2-second switch target holds in at least 95% of local trials with a responding server.
- No browser tab selection, panel open/close, or related-page click changes stored workspace membership.

The automated tests validate context and race logic; the Chrome walkthrough is required for native Side Panel behavior and narrow-width layout.
