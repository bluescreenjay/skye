# Contract: Shared clustering types

Lives in `packages/shared/src/clustering.ts`, re-exported from `packages/shared/src/index.ts`. The web app and every later client import these; nobody redeclares them (constitution principle V). Field names are camelCase here and snake_case in SQL; ids are UUID strings; times are UTC ISO-8601 strings.

## Change to `domain.ts`

```ts
export type PlacementSource = "ai" | "user";

export interface TabRef {
  // ...existing fields unchanged...
  /** null = never placed. "user" = the user placed it (or kept it in Other). "ai" = clustering placed it. */
  placementSource: PlacementSource | null;
}
```

`PlacementSource` is declared in `domain.ts` next to `TabRef` and re-exported. The 002 wire types (`TabSnapshotInput`, `TabEventInput`) `Pick` named fields from `TabRef`, so they are unaffected.

## New in `clustering.ts`

```ts
import type { TabRef, Workspace } from "./domain";

export type ClusterRunStatus = "running" | "succeeded" | "failed" | "undone";
export type SuggestionStatus = "pending" | "accepted" | "ignored" | "withdrawn";

export interface ClusterRun {
  id: string;
  userId: string;
  status: ClusterRunStatus;
  startedAt: string;
  finishedAt: string | null;
  consideredCount: number;
  leftOutCount: number;
  appliedCount: number;
  suggestionCount: number;
  discardedCount: number;
  createdWorkspaceIds: string[];
  error: string | null;
  undoneAt: string | null;
}

export interface Suggestion {
  id: string;
  userId: string;
  runId: string;
  name: string;
  emoji: string | null;
  targetWorkspaceId: string | null; // set: add the tabs to this existing workspace
  confidence: number; // 0..1
  tabRefIds: string[]; // as proposed; see SuggestionView for what is still eligible
  status: SuggestionStatus;
  createdAt: string;
  resolvedAt: string | null;
}

/** A suggestion as a client shows it: only the tabs that are still unplaced. */
export interface SuggestionView extends Suggestion {
  tabRefs: TabRef[];
  /** The existing workspace it would join, when targetWorkspaceId is set. */
  targetWorkspace: Workspace | null;
}

export interface AppliedGroup {
  workspace: Workspace;
  created: boolean; // true when the run created the workspace
  tabRefIds: string[];
}
```

Response bodies are defined in [http.md](./http.md); `POST /api/cluster/runs` returns `{ skipped, reason?, run, applied: AppliedGroup[], suggestions: SuggestionView[], leftOut }`.

## Sync rule

`apps/web/src/map.ts` maps rows to these types (adding `placement_source` to `DbTabRef`). Adding a field to any of them means updating this file, `data-model.md`, and `packages/shared/sql/004_clustering.sql` together.
