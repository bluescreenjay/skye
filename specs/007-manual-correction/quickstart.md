# Quickstart: Validate Manual Correction

Use after feature 007 is implemented. Validates [corrections.md](contracts/corrections.md) against Home, the Side Panel, and Chrome tab groups.

## Prerequisites

- Node.js 22+, pnpm 9, Chrome 116+ with tab groups available.
- 003 schema applied (includes `corrections`, `placement_source`). 004 clustering available for the “organize does not clobber” check.
- Root `.env` and `apps/extension/.env` paired with the same device token.
- At least two named workspaces, several Other tabs, and multiple open HTTP(S) tabs that match saved refs (use Home organize from 005b if needed).

## Build and run

~~~bash
pnpm install
pnpm typecheck
pnpm --filter @ai-browser/extension test
pnpm --filter @ai-browser/web test
pnpm --filter @ai-browser/web dev
pnpm --filter @ai-browser/extension build
~~~

Load `apps/extension/dist` unpacked; reload after each rebuild. Confirm the manifest lists `tabGroups`.

## Walkthrough

1. **Home drag**: On Home, drag a tab from workspace A to B. Reload Home. Expect membership still on B. Expect a `corrections` row (or equivalent server-side record) for the move.
2. **Home to Other / from Other**: Drag to Other, then back onto a named workspace. Expect durable membership each time.
3. **Rename**: Rename a workspace. Expect the new name on Home and on the Chrome group title after sync.
4. **Create**: Create a new workspace and place at least one tab into it. Expect it in the directory after reload.
5. **Sidebar move**: Open a page in A, open the Side Panel, move the active page to B (then Other). Expect the panel retargets within ~2s when the API is up; the page stays open.
6. **Dismiss suggestion** (if a pending suggestion is shown): Dismiss it. Expect no membership change; organize should not silently apply that ignored idea.
7. **Manual wins**: With user-placed tabs in place, run **organize** on Home. Expect those tabs to stay where the person put them.
8. **Chrome groups**: After corrections, expect open eligible tabs for each named workspace to sit in a Chrome tab group titled with that workspace name; Other tabs ungrouped. Incognito/internal/Home tabs untouched.
9. **Failure honesty**: Stop the API and attempt a move. Expect a quiet failure and no false “saved” or group reshuffle claiming success.
10. **Persistence**: Restart Chrome, reload the extension, open Home. Expect membership unchanged; groups can be rebuilt by a sync without redoing drags.

## Completion checks

- Built extension includes `tabGroups` permission and apply-groups behavior.
- No client-only workspace ids appear in the directory.
- Clustering does not override `placementSource: "user"` tabs.
- Server remains source of truth when Chrome group sync fails.

Automated tests cover placement/correction/clustering interactions; the Chrome walkthrough is required for visible tab groups and sidebar timing.
