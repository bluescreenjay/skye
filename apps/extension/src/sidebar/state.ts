import type { TabRef, Workspace } from "@ai-browser/shared";

export interface ActivePage {
  tabId: number;
  windowId: number;
  url: string;
}

export type PanelView =
  | { kind: "loading" }
  | { kind: "named"; page: ActivePage; workspace: Workspace; tabs: TabRef[] }
  | { kind: "other"; page: ActivePage; tabs: TabRef[] }
  | { kind: "ineligible" }
  | { kind: "unavailable"; message: string };
