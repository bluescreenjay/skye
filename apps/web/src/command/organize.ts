// Organize and clean up, through the SAME function Home's one-click organize uses
// (specs/011-global-command-bar/research.md 7; spec FR-011, FR-014). `runClustering` is called in this
// process, never over HTTP, so the rules are literally Home's: only never-placed tabs in Other move,
// low-confidence groups become suggestions, the run is recorded and can be undone, and a second run while
// one is going is refused. This file only maps its outcome to a command result, and registers the undo row.
import type { ChangeCounts, CommandApplyResult } from "@ai-browser/shared";
import { query } from "../db";
import { runClustering } from "../cluster/run";
import { applyRefusal } from "./errors";
import * as m from "./messages";
import { readUndo, recordUndo } from "./undo";

const ZERO: ChangeCounts = { moved: 0, alreadyThere: 0, missing: 0, workspacesCreated: 0, suggestions: 0, leftOut: 0 };

/** Runs Home's organize. A typed failure is a `refused` result (never a status that hides the state). */
export async function organizeChange(userId: string): Promise<CommandApplyResult> {
  try {
    const outcome = await runClustering(userId);
    const run = outcome.run;
    if (outcome.skipped || !run || run.appliedCount === 0) {
      // No change was made: the previous undo row (if any) stays as it is.
      const undo = await readUndo({ query }, userId);
      return {
        status: "nothing_to_do",
        // A skipped run hands back the PREVIOUS run for reference: only a run that just ran may report its suggestions.
        message: !outcome.skipped && run && run.suggestionCount > 0 ? `${m.NOTHING_TO_ORGANIZE} ${m.suggestionsLeft(run.suggestionCount)}` : m.NOTHING_TO_ORGANIZE,
        undo,
      };
    }
    const groups = outcome.applied.length;
    const counts: ChangeCounts = {
      ...ZERO,
      moved: run.appliedCount,
      workspacesCreated: run.createdWorkspaceIds.length,
      suggestions: run.suggestionCount,
      leftOut: outcome.leftOut,
    };
    await recordUndo({ query }, userId, "organize", m.summary.organize(run.appliedCount, groups), { v: 1, runId: run.id });
    return {
      status: "done",
      message: m.organizeDone(run.appliedCount, groups, run.suggestionCount),
      counts,
      undo: await readUndo({ query }, userId),
      next: null,
      workspace: null,
    };
  } catch (error) {
    const refusal = applyRefusal(error);
    if (refusal) return { status: "refused", code: refusal.code, message: refusal.message };
    throw error;
  }
}

/**
 * Clean up = organize the loose tabs, then the extension offers to close exact duplicate tabs (it alone can
 * see them: the server keeps one record per address). The duplicate step is offered even when nothing was
 * organized. The server closes nothing.
 */
export async function cleanupChange(userId: string): Promise<CommandApplyResult> {
  const result = await organizeChange(userId);
  if (result.status === "refused") return result;
  if (result.status === "nothing_to_do") {
    return { status: "done", message: m.CLEANUP_NOTHING_ORGANIZED, counts: { ...ZERO }, undo: result.undo, next: "scan_duplicates", workspace: null };
  }
  if (result.status === "done") return { ...result, next: "scan_duplicates" };
  return result;
}
