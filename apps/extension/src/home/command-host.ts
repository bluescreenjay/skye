// The bridge between the command bar and the browser (feature 011: specs/011-global-command-bar/contracts/extension.md,
// "Modules"). The bar itself (src/ui/CommandBar.tsx) never changes tabs: the observe-only test forbids
// `chrome.tabs.remove` and friends outside `home/` and `sidebar/`. Everything the bar needs from the browser
// comes through this object, which Home and the Side Panel both build. It imports nothing from `sidebar/`.
import type { CommandContext } from "@ai-browser/shared";
import type { CommandHost } from "../ui/command";
import { closeDuplicateTabs, findDuplicateTabs } from "./close-duplicates";
import { focusOrOpenSavedTab, openHomeTab, showHome } from "./navigation";

export type { CommandHost, DuplicatePlan } from "../ui/command";

export interface CommandHostOptions {
  surface: "home" | "page";
  /** Where the person is right now (read fresh at submit time). */
  getContext: () => Promise<CommandContext>;
  /** Reload what this surface shows. */
  refresh: () => void;
}

export function createCommandHost(options: CommandHostOptions): CommandHost {
  return {
    surface: options.surface,
    getContext: options.getContext,
    refresh: options.refresh,
    showHome: (target) => showHome(target),
    // On Home a click also brings the tab's workspace into the Side Panel, as a Home tab click does.
    openTab: async (tab) => {
      if (options.surface === "home") await openHomeTab(tab);
      else await focusOrOpenSavedTab(tab);
    },
    // Only the browser can see two open tabs of one address; the server keeps one record per address.
    scanDuplicates: async () => {
      const tabs = await chrome.tabs.query({});
      const focused = await chrome.windows.getLastFocused().catch(() => undefined);
      return findDuplicateTabs(tabs, focused?.id);
    },
    closeDuplicates: (plan) => closeDuplicateTabs(plan),
  };
}
