// The command bar shortcut (feature 011: specs/011-global-command-bar/contracts/extension.md,
// "The shortcut handler"). Runs in the service worker and does one thing: get the bar in front of the
// person, wherever they are.
//
//   a web page  -> open the Side Panel for that tab (it hosts the bar there), then ask it to open the bar
//   Home        -> ask Home to open the bar (it is already showing)
//   anything else (a browser page, a blank tab) or when the panel will not open -> open Home with the bar
//
// THE ONE RULE: `chrome.sidePanel.open` is called BEFORE ANY `await`. Chrome accepts a `commands`
// shortcut as the user gesture only in the same turn; after an await it rejects. So the decision is made
// from the `tab` the listener is given (not a `tabs.query`), and nothing above the open call is async.
//
// Only `background.ts` may create tabs (observe-only test), so opening Home is passed in as `openHome`.
import { isEligibleTab } from "./filters";
import { isHomeUrl } from "./sidepanel-gate";
import { sendSignal } from "./ui/command-signal";

export const OPEN_COMMAND = "open-command-bar";

export interface CommandShortcutOptions {
  /** Opens Home in a new tab (supplied by background.ts). */
  openHome: () => Promise<unknown> | unknown;
}

/** Opens Home with the bar. Never throws. */
function openHomeWithBar(openHome: CommandShortcutOptions["openHome"]): void {
  Promise.resolve()
    .then(openHome)
    .then(() => sendSignal({ kind: "open", tabId: "new" }))
    .catch(() => console.warn("[ai-browser] could not open Home for the command bar"));
}

function handle(tab: chrome.tabs.Tab | undefined, options: CommandShortcutOptions): void {
  if (tab && typeof tab.id === "number") {
    const tabId = tab.id;
    if (isHomeUrl(tab.url)) {
      void sendSignal({ kind: "open", tabId });
      return;
    }
    if (isEligibleTab(tab)) {
      // FIRST, in this very turn: nothing before this line awaits.
      let opened: Promise<void>;
      try {
        opened = chrome.sidePanel.open({ tabId });
      } catch {
        openHomeWithBar(options.openHome);
        return;
      }
      void sendSignal({ kind: "open", tabId });
      opened.catch(() => openHomeWithBar(options.openHome)); // Chrome refused: the documented fallback
      return;
    }
  }
  openHomeWithBar(options.openHome);
}

/** Registers the listener. Wiring only; call it once from the top level of background.ts. */
export function installCommandShortcut(options: CommandShortcutOptions): void {
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command !== OPEN_COMMAND) return;
    try {
      handle(tab, options);
    } catch {
      console.warn("[ai-browser] the command bar shortcut failed");
    }
  });
}
