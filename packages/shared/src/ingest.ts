// Wire types for tab ingestion (feature 002). Derived from the canonical
// TabRef / TabEvent in domain.ts with Pick, so there is no second definition.
// userId, tabRefId and workspaceId are deliberately absent: the server derives
// or decides them. See specs/002-tab-ingestion-extension/contracts/.
import type { TabEvent, TabEventType, TabRef } from "./domain";

/** Maximum snippet length in characters (see TabRef.snippet in the 001 data model). */
export const SNIPPET_MAX_LENGTH = 2000;

/** Event types the ingestion extension emits. `reassigned` belongs to workspace features. */
export type IngestEventType = Exclude<TabEventType, "reassigned">;

/** One tab's current state, as observed by the extension. */
export type TabSnapshotInput = Pick<
  TabRef,
  "url" | "title" | "snippet" | "lastSeenAt"
> & {
  /** TabRef.chromeTabId narrowed: always known here. Valid only for this browser session. */
  chromeTabId: number;
  windowId: number;
  /** True if this is the active tab in its window. */
  active: boolean;
};

/** One tab event, as captured by the extension. */
export type TabEventInput = Pick<TabEvent, "id" | "time" | "url" | "title"> & {
  chromeTabId: number;
  eventType: IngestEventType;
};

/** The focused window and its active reportable tab (null ids when there is none). */
export interface IngestActiveTab {
  windowId: number | null;
  chromeTabId: number | null;
}

export interface IngestBatchRequest {
  batchId: string;
  /** ISO-8601 */
  sentAt: string;
  /** True when `tabs` lists every reportable open tab. */
  fullSnapshot: boolean;
  active: IngestActiveTab;
  tabs: TabSnapshotInput[];
  /** In occurrence order, at most 100. */
  events: TabEventInput[];
}

export interface IngestBatchResponse {
  accepted: number;
  duplicates: number;
}
