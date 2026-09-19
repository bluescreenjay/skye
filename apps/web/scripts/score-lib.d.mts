export interface ScoreResult {
  percent: number;
  correct: number;
  total: number;
  mismatches: { url: string; label: string | null; expectedWorkspace: string | null; actualWorkspace: string | null }[];
}

export function scoreClusters(
  labels: Record<string, string | null>,
  ambiguous: string[],
  workspaceByUrl: Record<string, string | null>,
): ScoreResult;
