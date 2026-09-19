// Pure helpers for "did anything change?" and "is this the same group again?".
import { createHash } from "crypto";
import type { Candidate, WorkspaceRef } from "./prompt";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * A digest of the state a run works from: the candidate tabs (id, address, title, a
 * hash of the snippet) and the active workspaces (id, name). Two runs with the same
 * digest would ask the model the same question, so the second can be skipped.
 * Order does not matter.
 */
export function fingerprint(candidates: Candidate[], workspaces: WorkspaceRef[]): string {
  const tabs = candidates
    .map((c) => [c.id, c.url, c.title, sha256(c.snippet)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const spaces = workspaces
    .map((w) => [w.id, w.name] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(JSON.stringify({ tabs, spaces }));
}

/** Jaccard similarity of two id lists: shared / total distinct. 0 when both are empty. */
export function jaccard(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  let shared = 0;
  for (const id of left) if (right.has(id)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Two groups are "the same group" for suggestion purposes at or above this overlap (research section 7). */
export const SAME_GROUP_OVERLAP = 0.7;
