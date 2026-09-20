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

/** Drop cards that no longer have any live tabs (optimistic empty-archive). */
function withoutEmptyCards(directory: HomeDirectory): HomeDirectory {
  return {
    other: directory.other,
    cards: directory.cards.filter((card) => card.tabs.length > 0),
  };
}

/** Other = workspaceId == null. Archived workspaces are omitted. Only live-bound tabs appear. Cards with no live tabs are omitted (archive on empty). */
export function composeDirectory(workspaces: Workspace[], tabRefs: TabRef[]): HomeDirectory {
  const live = tabRefs.filter(isLive);
  const other = live.filter((tab) => tab.workspaceId == null);
  const cards = workspaces
    .filter((workspace) => workspace.status !== "archived")
    .map((workspace) => ({
      workspace,
      tabs: live.filter((tab) => tab.workspaceId === workspace.id),
    }))
    .filter((card) => card.tabs.length > 0);
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

/** Drop a tab from the Home view by TabRef id (optimistic close). Empty cards are removed. */
export function dropTabById(directory: HomeDirectory, tabId: string): HomeDirectory {
  return withoutEmptyCards({
    other: directory.other.filter((tab) => tab.id !== tabId),
    cards: directory.cards.map((card) => ({
      ...card,
      tabs: card.tabs.filter((tab) => tab.id !== tabId),
    })),
  });
}

/** Drop a tab from the Home view by live Chrome tab id (onRemoved). Empty cards are removed. */
export function dropTabByChromeTabId(directory: HomeDirectory, chromeTabId: number): HomeDirectory {
  return withoutEmptyCards({
    other: directory.other.filter((tab) => tab.chromeTabId !== chromeTabId),
    cards: directory.cards.map((card) => ({
      ...card,
      tabs: card.tabs.filter((tab) => tab.chromeTabId !== chromeTabId),
    })),
  });
}

/** Remove a workspace card optimistically (archive). Its live tabs move to Other. */
export function dropWorkspaceCard(directory: HomeDirectory, workspaceId: string): HomeDirectory {
  const card = directory.cards.find((item) => item.workspace.id === workspaceId);
  if (!card) return directory;
  const moved = card.tabs.map((tab) => ({ ...tab, workspaceId: null }));
  return {
    other: [...directory.other, ...moved],
    cards: directory.cards.filter((item) => item.workspace.id !== workspaceId),
  };
}

/** Workspace ids that had live tabs in `before` but none in `after` (need server archive). */
export function emptiedWorkspaceIds(before: HomeDirectory, after: HomeDirectory): string[] {
  const afterIds = new Set(after.cards.map((card) => card.workspace.id));
  return before.cards
    .filter((card) => card.tabs.length > 0 && !afterIds.has(card.workspace.id))
    .map((card) => card.workspace.id);
}
