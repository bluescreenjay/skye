# Contract: Extension side of the command bar

What the extension adds and the rules its modules keep. The server side is in [http.md](./http.md) and [model.md](./model.md); types in [shared-command-types.md](./shared-command-types.md).

## Manifest

One new key and nothing else:

```ts
commands: {
  "open-command-bar": {
    suggested_key: { default: "Ctrl+K", mac: "Command+K" },
    description: "Open the command bar",
  },
},
```

No new permission (`commands` needs none), no `content_scripts`, no `web_accessible_resources`, no new host permission. `manifest.test.ts` currently asserts `commands` is absent; that assertion is replaced by an assertion of exactly this entry (flagged in the plan). Everything else in that test stays.

If Chrome cannot assign the key (another extension or the browser owns it), it is left unassigned; the person sets a key at `chrome://extensions/shortcuts`, and the visible control always opens the same bar (FR-001).

## Modules

| File | Runs in | Role | Touches `chrome.*` |
| --- | --- | --- | --- |
| `src/command-shortcut.ts` | service worker | `installCommandShortcut({ openHome })`: the `commands.onCommand` handler | `commands`, `sidePanel.open`, `storage.session` |
| `src/ui/command.ts` | pages | Pure client and helpers: `interpretCommand`, `applyCommand`, `readUndo` (never throw; every outcome is a value), `clipCommand`, `EXAMPLES`, the bar's reducer, message helpers | none |
| `src/ui/command-signal.ts` | pages, worker | The `command.signal` key: `sendSignal`, `onSignal`, `takeFreshSignal` | `storage.session` |
| `src/ui/CommandBar.tsx`, `src/ui/command.css` | Home and the panel | The shared component. Imports nothing Home-specific or sidebar-specific; everything it needs from the host comes in through props | none (reads none directly) |
| `src/home/command-host.ts` | Home and the panel | `createCommandHost(...)`: the browser-facing functions the bar calls (below). Under `home/` so `chrome.tabs.remove` is allowed there | `tabs`, `windows`, `sidePanel` (through `home/navigation.ts`) |
| `src/home/close-duplicates.ts` | Home and the panel | `findDuplicateTabs`, `closeDuplicateTabs` | `tabs.query`, `tabs.get`, `tabs.remove` |
| `src/home/Home.tsx` | Home | Mounts the bar; ⌘K button; reacts to `open`, `changed`, `navigate` signals | |
| `src/sidebar/Sidebar.tsx` | panel | Mounts the bar; ⌘K button in the header; reacts to `open` and `changed` | |
| `src/background.ts` | service worker | Calls `installCommandShortcut({ openHome })` (wiring only) | |

The bar (`ui/`) never calls a `chrome.*` function that changes tabs; the observe-only test would fail if it did. The host object is the only bridge:

```ts
export interface CommandHost {
  surface: "home" | "page";
  /** Read fresh at submit time. */
  getContext(): Promise<CommandContext>;
  /** Home reloads its directory; the sidebar reloads its view. Called after a change and on a `changed` signal. */
  refresh(): void;
  /** Bring Home forward; with a workspace, expand its card. */
  showHome(target: NavTarget): Promise<void>;
  /** Focus an open tab, or open its address in a new tab (`focusOrOpenSavedTab`). */
  openTab(tab: TabRef): Promise<void>;
  /** The exact-address duplicates among live tabs, with the copy to keep. */
  scanDuplicates(): Promise<DuplicatePlan>;
  /** Re-checks each tab, closes only the extras that still match, returns counts. */
  closeDuplicates(plan: DuplicatePlan): Promise<{ closed: number; skipped: number }>;
}
```

## The shortcut handler

```ts
chrome.commands.onCommand.addListener((command, tab) => { … });
```

Rules, in order, inside one listener:

1. Ignore any command other than `open-command-bar`.
2. **No `await` before `sidePanel.open`.** Chrome accepts the shortcut as the user gesture only if the call starts in the same turn. Decide from `tab` (the listener's argument), not from a `tabs.query`.
3. `tab` is an eligible web page (`isEligibleTab`, not incognito, not Home): `chrome.sidePanel.open({ tabId: tab.id })` first (`.catch` to the fallback below), then `sendSignal({ kind: "open", tabId: tab.id })`. The existing gate (`installSidePanelGate`) already enables the panel for every eligible page whenever a tab is activated or updated, so no `setOptions` call is needed ahead of `open`. (`openHomeTab` needs one only because Home had disabled the panel on the previous tab.)
4. `tab` is Home: `sendSignal({ kind: "open", tabId: tab.id })`.
5. Anything else (a browser page, a blank tab, no tab): `openHome()` (supplied by `background.ts`), then a signal `{ kind: "open", tabId: "new" }` that the new Home takes on mount.
6. Fallback if `sidePanel.open` rejects: step 5. Never throws out of the listener; failures log a fixed label only.

The bar in the panel opens because the panel reads a fresh `open` signal when it mounts (the panel may not exist yet when the signal is written) and on `storage.onChanged` (when it already exists). An `open` signal **toggles**: if the bar is open in that page, it closes (FR-003, "the shortcut again").

The page-level `keydown` for ⌘K/Ctrl+K in Home and the panel is only a convenience for when Chrome did not assign the command; it is the same toggle.

## Signals (`command.signal` in `chrome.storage.session`)

```ts
type CommandSignal =
  | { kind: "open"; tabId: number | "new"; at: number }
  | { kind: "changed"; at: number }
  | { kind: "navigate"; target: NavTarget; at: number };
```

- One key, overwritten each time; `at` is `Date.now()`, so two identical signals still fire `onChanged`.
- A page acts on `onChanged`, and on mount acts on a signal fresher than `SIGNAL_FRESH_MS` (3 s) that it has not yet handled (it remembers the `at` of the last one it handled in memory).
- `open` is acted on by Home only when `tabId` equals its own tab id (`chrome.tabs.getCurrent`) or is `"new"` and Home has just loaded; by the panel only when `tabId` equals the active tab of its window.
- `changed` makes Home run its `refresh` (reload directory) and the sidebar reload its view. It is written after every `done` from `/apply` that changed something, and after an agent run finishes from the bar. Nothing polls.
- `navigate` makes Home expand the card for `workspaceId` (Home has one `expandedId`) or just come forward for `home`.
- Everything is best-effort: a storage error is swallowed (`try/catch`), the bar still works, and the person can reload.

## Behaviors the bar must have (FR / SC map)

| Behavior | Requirement |
| --- | --- |
| Opens with the text box focused and about six examples; no request | FR-001, FR-002, SC-001 |
| Typing sends nothing; there is no debounce, autocomplete, or prefetch | FR-002, FR-029, SC-008 |
| Enter with empty or whitespace text does nothing and makes no request | Edge case, SC-008 |
| Over 300 characters: cut to 300 and show "Shortened to 300 characters" **before** sending | FR-027 |
| Shows the `understood` sentence as the command starts | FR-009 |
| Escape, click-away, or the shortcut closes the bar without cancelling; the in-flight promise lives in a module-level controller, and reopening shows the current state and result | FR-003, User Story 6 scenario 7 |
| On open, calls `GET /api/command/undo` and shows Undo if present; the Undo control and the typed word "undo" do the same `apply { undo }` | FR-019 |
| `needs_confirmation` shows the preview (titles as text, at most 20, "and N more") with **Confirm** and **Cancel**; Cancel changes nothing | FR-018, SC-006 |
| `ask` shows one button per choice; nothing has run | FR-006, FR-007, FR-010 |
| A failure shows a plain sentence, **keeps the typed text**, offers try again (which is another submit), and never shows a failure as a result | FR-026, FR-028, SC-011 |
| Cannot reach the server: says so once, keeps what is on screen, invents nothing | FR-026 |
| Not paired: "This browser isn't connected yet." and no request | Edge case |
| After a change, calls `host.refresh()` and writes `changed` | FR-025, SC-004 |
| Agent: `pressAgent`, then poll `readAgents` at `POLL_MS` for at most `AGENT_WAIT_MS`; show `resultText` cut to the first 6 lines and "Open workspace" | FR-017, SC-005 |
| Cleanup: after `done` with `next: "scan_duplicates"`, `host.scanDuplicates()`; a non-empty plan shows the list (title and copies) and Confirm/Cancel; Confirm calls `host.closeDuplicates`; the copy says closing cannot be undone | FR-014 |
| A failure in the bar (an exception) is caught by an error boundary around it; Home and the sidebar keep working | FR-024, SC-013 |
| Every string from a reply is a plain text node | shared-command-types rule 1 |
| The bar keeps no history of commands (no list of past commands, no suggestions from them, nothing in storage) | FR-030 |

## Duplicate rules (`close-duplicates.ts`)

`findDuplicateTabs(tabs)` takes `chrome.tabs.Tab[]` (from a `chrome.tabs.query({})` filtered to eligible tabs: `http`/`https`, not incognito, normal windows) and returns groups where the **whole URL string** is equal. Within a group, the copy kept is: the active tab of a focused window if any; else the first pinned tab; else the tab with the lowest window id, then lowest index. No group closes a pinned tab. Groups of one are not returned. `closeDuplicateTabs(plan)` calls `chrome.tabs.get(id)` for each tab to close and closes it only if it still exists, is not incognito, is not pinned, and its URL still equals the group's; otherwise it counts as skipped. It calls `chrome.tabs.remove` with the ids that passed, once.
