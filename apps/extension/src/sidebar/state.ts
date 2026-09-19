import type { TabRef, Workspace } from "@ai-browser/shared";

export interface ActivePage {
  tabId: number;
  windowId: number;
  url: string;
}

export type PanelView =
  | { kind: "loading" }
  | { kind: "named"; page: ActivePage; workspace: Workspace; tabs: TabRef[]; tabRef: TabRef | null }
  | { kind: "other"; page: ActivePage; tabs: TabRef[]; tabRef: TabRef | null }
  | { kind: "ineligible" }
  | { kind: "unavailable"; message: string };
