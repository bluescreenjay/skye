// Types for AI clustering (feature 004). The web app maps database rows to these;
// Home and the sidebar import them from `@ai-browser/shared` and must not
// redeclare them. Contract: specs/004-ai-clustering/contracts/shared-clustering-types.md
// IDs are UUID strings; timestamps are UTC ISO-8601 strings.
import type { TabRef, Workspace } from "./domain";

export type ClusterRunStatus = "running" | "succeeded" | "failed" | "undone";
export type SuggestionStatus = "pending" | "accepted" | "ignored" | "withdrawn";

/** One execution of clustering for a user. The unit the user can undo. */
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

/** A stored proposal ("these tabs look like X"). Never moves a tab until accepted. */
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
