import type { TabRef, Workspace } from "@ai-browser/shared";

export interface WorkspaceCard {
  workspace: Workspace;
  tabs: TabRef[];
}

export interface HomeDirectory {
  other: TabRef[];
  cards: WorkspaceCard[];
}

/** Other = workspaceId == null. Archived workspaces are omitted. Empty named workspaces still get a card. */
export function composeDirectory(workspaces: Workspace[], tabRefs: TabRef[]): HomeDirectory {
  const other = tabRefs.filter((tab) => tab.workspaceId == null);
  const cards = workspaces
    .filter((workspace) => workspace.status !== "archived")
    .map((workspace) => ({
      workspace,
      tabs: tabRefs.filter((tab) => tab.workspaceId === workspace.id),
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
