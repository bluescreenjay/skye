# Contract: ingest types in `@ai-browser/shared`

Feature 002 adds one file to the shared package. These types are **derived from** the canonical 001 types with `Pick`, so there is no second definition of `TabRef` or `TabEvent` (FR-015, constitution Principle V). The extension and the future server MUST import them from `@ai-browser/shared` and MUST NOT redeclare them.

## File

`packages/shared/src/ingest.ts`, re-exported from `packages/shared/src/index.ts` (`export * from "./ingest";`).

## Required exports

```ts
import type { TabEvent, TabEventType, TabRef } from "./domain";

/** Maximum snippet length in characters (see 001 data-model: TabRef.snippet). */
export const SNIPPET_MAX_LENGTH = 2000;

/** Event types this feature emits. `reassigned` belongs to workspace features. */
export type IngestEventType = Exclude<TabEventType, "reassigned">;

/** One tab's current state, as observed by the extension. */
export type TabSnapshotInput = Pick<
  TabRef,
  "url" | "title" | "snippet" | "lastSeenAt"
> & {
  chromeTabId: number; // TabRef.chromeTabId narrowed: always known here
  windowId: number;
  active: boolean;
};

/** One tab event, as captured by the extension. */
export type TabEventInput = Pick<
  TabEvent,
  "id" | "time" | "url" | "title"
> & {
  chromeTabId: number;
  eventType: IngestEventType;
};

export interface IngestActiveTab {
  windowId: number | null;
  chromeTabId: number | null;
}

export interface IngestBatchRequest {
  batchId: string;
  sentAt: string; // ISO-8601
  fullSnapshot: boolean;
  active: IngestActiveTab;
  tabs: TabSnapshotInput[];
  events: TabEventInput[]; // in occurrence order, at most 100
}

export interface IngestBatchResponse {
  accepted: number;
  duplicates: number;
}
```

## Notes

- `userId`, `tabRefId`, and `workspaceId` are deliberately absent: the server derives or decides them.
- `SNIPPET_MAX_LENGTH` is a small constant, consistent with the "types and small consts only" rule for the shared package (research 001 §2).
- Update `packages/shared/README.md` with a short section listing these ingest types.
- Compile check: `pnpm --filter @ai-browser/shared typecheck` and `pnpm -r typecheck`.
- HTTP contract: [ingest-api.md](./ingest-api.md). Persisted-state and wire-field rules: [../data-model.md](../data-model.md).
