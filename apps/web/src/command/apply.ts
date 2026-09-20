// POST /api/command/apply (specs/011-global-command-bar/contracts/http.md). The SERVER decides whether an
// action needs a confirmation, from the action and the current state (research 2):
//   organize, cleanup, undo ......... never
//   group, move, rename, merge ...... always
//   create .......................... only when a tab in the set was placed by the person
// An action that needs it and lacks `confirmed: true` returns `needs_confirmation` with the exact list of
// changes, and changes nothing. Every handler re-validates ids against the CURRENT state.
import type { ChangeCounts, CommandAction, CommandApplyResult } from "@ai-browser/shared";
import { getAgent } from "../agents/catalog";
import { query } from "../db";
import { isUuid } from "./context";
import { badAction } from "./errors";
import { buildPreview, createChange, groupChange, mergeChange, moveChange, renameChange } from "./changes";
import * as m from "./messages";
import { cleanupChange, organizeChange } from "./organize";
import { readUndo, undoLast } from "./undo";

export const ZERO_COUNTS: ChangeCounts = { moved: 0, alreadyThere: 0, missing: 0, workspacesCreated: 0, suggestions: 0, leftOut: 0 };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function nameOf(value: unknown): string {
  if (typeof value !== "string") throw badAction();
  const name = value.trim();
  if (name.length < 1 || name.length > 80) throw badAction();
  return name;
}

/** Shape only: a set larger than one change may touch is refused by the executor as `too_many` (not a malformed action). */
const MAX_SHAPE_IDS = 1_000;

function tabIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SHAPE_IDS || !value.every(isUuid)) throw badAction();
  return [...new Set(value as string[])];
}

/** Checks the shape of an action; a malformed one is 400 `bad_action`. Ids are checked against the database later. */
export function parseAction(raw: unknown): CommandAction {
  if (!isObject(raw) || typeof raw.type !== "string") throw badAction();
  switch (raw.type) {
    case "organize":
    case "cleanup":
    case "undo":
      return { type: raw.type };
    case "group": {
      const t = raw.target;
      if (!isObject(t)) throw badAction();
      if (typeof t.workspaceId === "string") {
        if (!isUuid(t.workspaceId)) throw badAction();
        return { type: "group", tabRefIds: tabIds(raw.tabRefIds), target: { workspaceId: t.workspaceId } };
      }
      return { type: "group", tabRefIds: tabIds(raw.tabRefIds), target: { newName: nameOf(t.newName) } };
    }
    case "move": {
      if (raw.toWorkspaceId !== null && !isUuid(raw.toWorkspaceId)) throw badAction();
      return { type: "move", tabRefIds: tabIds(raw.tabRefIds), toWorkspaceId: raw.toWorkspaceId };
    }
    case "rename":
      if (!isUuid(raw.workspaceId)) throw badAction();
      return { type: "rename", workspaceId: raw.workspaceId, name: nameOf(raw.name) };
    case "merge":
      if (!isUuid(raw.fromWorkspaceId) || !isUuid(raw.intoWorkspaceId)) throw badAction();
      return { type: "merge", fromWorkspaceId: raw.fromWorkspaceId, intoWorkspaceId: raw.intoWorkspaceId };
    case "create":
      return { type: "create", name: nameOf(raw.name), tabRefIds: tabIds(raw.tabRefIds) };
    case "agent": {
      // An agent is pressed through the 010 route by the client, never applied here.
      if (!isUuid(raw.workspaceId) || typeof raw.agentId !== "string" || !getAgent(raw.agentId)) throw badAction();
      throw badAction();
    }
    default:
      throw badAction();
  }
}

/** The confirmation table (research 2). `create` asks only when a tab in the set was placed by the person. */
export async function requiresConfirmation(userId: string, action: CommandAction): Promise<boolean> {
  switch (action.type) {
    case "group":
    case "move":
    case "rename":
    case "merge":
      return true;
    case "create": {
      const result = await query<{ n: string }>(
        `SELECT count(*) AS n FROM tab_refs WHERE user_id = $1::uuid AND id = ANY($2::uuid[]) AND placement_source = 'user'`,
        [userId, action.tabRefIds],
      );
      return Number(result.rows[0].n) > 0;
    }
    default:
      return false;
  }
}

type ApplyHandlers = {
  [K in CommandAction["type"]]?: (userId: string, action: Extract<CommandAction, { type: K }>, confirmed: boolean) => Promise<CommandApplyResult>;
};

async function undoHandler(userId: string): Promise<CommandApplyResult> {
  const outcome = await undoLast(userId);
  const undo = await readUndo({ query }, userId);
  if (outcome.nothing) return { status: "nothing_to_do", message: outcome.message, undo };
  return { status: "done", message: outcome.message, counts: { ...ZERO_COUNTS, moved: outcome.reverted }, undo, next: null, workspace: null };
}

/** Handlers by action type; each story adds its own. */
const APPLY: ApplyHandlers = {
  undo: (userId) => undoHandler(userId),
  organize: (userId) => organizeChange(userId),
  cleanup: (userId) => cleanupChange(userId),
  create: (userId, action) => createChange(userId, action),
  group: (userId, action) => groupChange(userId, action),
  move: (userId, action) => moveChange(userId, action),
  rename: (userId, action) => renameChange(userId, action),
  merge: (userId, action) => mergeChange(userId, action),
};

export async function applyAction(userId: string, raw: unknown, confirmed: boolean): Promise<CommandApplyResult> {
  const action = parseAction(raw);
  const handler = APPLY[action.type] as ((userId: string, action: CommandAction, confirmed: boolean) => Promise<CommandApplyResult>) | undefined;
  if (!handler) return { status: "refused", code: "not_found", message: m.REFUSAL.not_found };
  if (!confirmed && (await requiresConfirmation(userId, action))) {
    return { status: "needs_confirmation", preview: await buildPreview(userId, action) };
  }
  return handler(userId, action, confirmed);
}
