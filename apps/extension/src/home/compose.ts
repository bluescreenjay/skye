import type { TabRef, Workspace } from "@ai-browser/shared";

export interface WorkspaceCard {
  workspace: Workspace;
  tabs: TabRef[];
}

export interface HomeDirectory {
  other: TabRef[];
  cards: WorkspaceCard[];
}

function isLive(tab: TabRef): boolean {
  return tab.chromeTabId != null;
}

/** Other = workspaceId == null. Archived workspaces are omitted. Empty named workspaces still get a card. Only live-bound tabs appear. */
export function composeDirectory(workspaces: Workspace[], tabRefs: TabRef[]): HomeDirectory {
  const live = tabRefs.filter(isLive);
  const other = live.filter((tab) => tab.workspaceId == null);
  const cards = workspaces
    .filter((workspace) => workspace.status !== "archived")
    .map((workspace) => ({
      workspace,
      tabs: live.filter((tab) => tab.workspaceId === workspace.id),
    }));
  return { other, cards };
}

/** Apply a drag membership change without inventing rows. */
export function moveTabRef(
  directory: HomeDirectory,
  tabId: string,
  workspaceId: string | null,
): HomeDirectory {
  const tabs = [
    ...directory.other,
    ...directory.cards.flatMap((card) => card.tabs),
  ].map((tab) => (tab.id === tabId ? { ...tab, workspaceId } : tab));
  return composeDirectory(
    directory.cards.map((card) => card.workspace),
    tabs,
  );
}

/** Drop a tab from the Home view by TabRef id (optimistic close). */
export function dropTabById(directory: HomeDirectory, tabId: string): HomeDirectory {
  return {
    other: directory.other.filter((tab) => tab.id !== tabId),
    cards: directory.cards.map((card) => ({
      ...card,
      tabs: card.tabs.filter((tab) => tab.id !== tabId),
    })),
  };
}

/** Drop a tab from the Home view by live Chrome tab id (onRemoved). */
export function dropTabByChromeTabId(directory: HomeDirectory, chromeTabId: number): HomeDirectory {
  return {
    other: directory.other.filter((tab) => tab.chromeTabId !== chromeTabId),
    cards: directory.cards.map((card) => ({
      ...card,
      tabs: card.tabs.filter((tab) => tab.chromeTabId !== chromeTabId),
    })),
  };
}
