// The changes the bar makes to how tabs and workspaces are organized: create, group, move, rename, merge
// (specs/011-global-command-bar/research.md 8). Each is ONE transaction that first takes the person's
// advisory lock (so two changing commands never interleave and the undo row stays consistent), does its
// work set-based, and records what Undo needs. A failure inside rolls all of it back. Nothing here logs.
//
// The rules they share with a drag on Home:
//   - a placement is recorded as the person's own (`placement_source = 'user'`);
//   - a tab the AI had placed that changes workspace also writes a `corrections` row (a signal, principle III);
//   - a `reassigned` tab event is written per moved tab.
import { randomUUID } from "crypto";
import type { PoolClient } from "pg";
import type { ChangeCounts, ChangePreview, CommandAction, CommandApplyResult, CommandRefusalCode } from "@ai-browser/shared";
import { query, withTransaction } from "../db";
import { recordReassignments } from "../cluster/apply";
import { findExistingWorkspace, isReservedName } from "../cluster/target";
import { workspaceNames, readTabs, type TabRow } from "./context";
import { MAX_MOVES_PER_CHANGE, MAX_PREVIEW_LINES } from "./limits";
import * as m from "./messages";
import { readUndo, recordUndo, type UndoPayload } from "./undo";

type Move = Extract<UndoPayload, { moves: unknown }>["moves"][number];

export const ZERO: ChangeCounts = { moved: 0, alreadyThere: 0, missing: 0, workspacesCreated: 0, suggestions: 0, leftOut: 0 };

/** Thrown inside a change to stop it: the transaction rolls back and the caller answers with a refusal. */
export class Refused extends Error {
  constructor(readonly code: CommandRefusalCode) {
    super(code);
    this.name = "Refused";
  }
}

export const refused = (code: CommandRefusalCode): CommandApplyResult => ({ status: "refused", code, message: m.REFUSAL[code] });

/** One transaction under the person's advisory lock (the same key Undo takes). A `Refused` inside becomes a refusal. */
export async function withChange(userId: string, work: (client: PoolClient) => Promise<CommandApplyResult>): Promise<CommandApplyResult> {
  try {
    return await withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [`command:${userId}`]);
      return work(client);
    });
  } catch (error) {
    if (error instanceof Refused) return refused(error.code);
    throw error;
  }
}

export interface Placed {
  moves: Move[];
  alreadyThere: number;
  missing: number;
}

/**
 * Puts tabs in a workspace (`null` = Other), as the person's own placement. Tabs that do not exist (or are not
 * this person's) are counted `missing`; tabs already at the destination are left alone and counted.
 */
export async function placeTabs(client: PoolClient, userId: string, tabRefIds: string[], toWorkspaceId: string | null): Promise<Placed> {
  const found = await client.query<{ id: string; url: string; workspace_id: string | null; placement_source: "ai" | "user" | null }>(
    `SELECT id, url, workspace_id, placement_source FROM tab_refs
     WHERE user_id = $1::uuid AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
    [userId, tabRefIds],
  );
  const missing = new Set(tabRefIds).size - found.rows.length;
  const toMove = found.rows.filter((r) => r.workspace_id !== toWorkspaceId);
  const alreadyThere = found.rows.length - toMove.length;
  if (toMove.length === 0) return { moves: [], alreadyThere, missing };

  const ids = toMove.map((r) => r.id);
  // The corrections first: they need the workspace each tab is leaving.
  const aiPlaced = toMove.filter((r) => r.placement_source === "ai");
  if (aiPlaced.length > 0) {
    await client.query(
      `INSERT INTO corrections (id, user_id, from_workspace_id, to_workspace_id, tab_ref_id, url)
       SELECT gen_random_uuid(), $1::uuid, x.from_ws, $2::uuid, x.tab_id, x.url
       FROM unnest($3::uuid[], $4::uuid[], $5::text[]) AS x(tab_id, from_ws, url)`,
      [userId, toWorkspaceId, aiPlaced.map((r) => r.id), aiPlaced.map((r) => r.workspace_id), aiPlaced.map((r) => r.url)],
    );
  }
  await client.query(
    `UPDATE tab_refs SET workspace_id = $3::uuid, placement_source = 'user'
     WHERE user_id = $1::uuid AND id = ANY($2::uuid[])`,
    [userId, ids, toWorkspaceId],
  );
  await recordReassignments(client, userId, ids, toWorkspaceId);
  return {
    moves: toMove.map((r) => ({ tabRefId: r.id, fromWorkspaceId: r.workspace_id, fromSource: r.placement_source, toWorkspaceId })),
    alreadyThere,
    missing,
  };
}

/**
 * The name rules of a hand rename, checked against the person's non-archived workspaces (trim and case-folded):
 * `Other` is reserved, and a name another workspace has is taken. `exceptId` lets a workspace keep its own name
 * (so a rename may change only the case).
 */
export async function checkName(client: PoolClient, userId: string, name: string, exceptId: string | null = null): Promise<"ok" | "reserved_name" | "name_taken"> {
  if (isReservedName(name)) return "reserved_name";
  const clash = await client.query(
    `SELECT 1 FROM workspaces
     WHERE user_id = $1::uuid AND status <> 'archived' AND lower(btrim(name)) = lower(btrim($2))
       AND ($3::uuid IS NULL OR id <> $3::uuid)
     LIMIT 1`,
    [userId, name, exceptId],
  );
  return (clash.rowCount ?? 0) > 0 ? "name_taken" : "ok";
}

const countsOf = (over: Partial<ChangeCounts>): ChangeCounts => ({ ...ZERO, ...over });

/** A finished change: the undo row is written, and the result carries the state after it. */
async function finishChange(
  client: PoolClient,
  userId: string,
  kind: "create" | "group" | "move" | "merge",
  summary: string,
  placed: Placed,
  extra: { createdWorkspaceId?: string; message: string; workspace: { id: string; name: string } | null; counts?: Partial<ChangeCounts> },
): Promise<CommandApplyResult> {
  await recordUndo(client, userId, kind, summary, { v: 1, moves: placed.moves, ...(extra.createdWorkspaceId ? { createdWorkspaceId: extra.createdWorkspaceId } : {}) });
  return {
    status: "done",
    message: extra.message,
    counts: countsOf({ moved: placed.moves.length, alreadyThere: placed.alreadyThere, missing: placed.missing, ...extra.counts }),
    undo: await readUndo(client, userId),
    next: null,
    workspace: extra.workspace,
  };
}

type CreateAction = Extract<CommandAction, { type: "create" }>;

/** Creates the workspace with exactly the given name and puts the tabs in it. */
export async function createChange(userId: string, action: CreateAction): Promise<CommandApplyResult> {
  if (action.tabRefIds.length > MAX_MOVES_PER_CHANGE) return refused("too_many");
  return withChange(userId, async (client) => {
    const name = action.name.trim();
    const check = await checkName(client, userId, name);
    if (check !== "ok") throw new Refused(check);
    const workspaceId = randomUUID();
    await client.query(`INSERT INTO workspaces (id, user_id, name, emoji, status) VALUES ($1::uuid, $2::uuid, $3, NULL, 'active')`, [workspaceId, userId, name]);
    const placed = await placeTabs(client, userId, action.tabRefIds, workspaceId);
    if (placed.moves.length === 0) throw new Refused("not_found"); // rolls the workspace back too
    return finishChange(client, userId, "create", m.summary.create(name, placed.moves.length), placed, {
      createdWorkspaceId: workspaceId,
      message: m.createDone(name, placed.moves.length, placed.alreadyThere, placed.missing),
      workspace: { id: workspaceId, name },
      counts: { workspacesCreated: 1 },
    });
  });
}

type GroupAction = Extract<CommandAction, { type: "group" }>;

/**
 * Puts described tabs together. The target is an active workspace by id, or a name: an existing workspace
 * with that name (trim and case-folded, so no near-duplicate is made), else a new one. Always confirmed
 * before it gets here. Tabs already in place are left alone; if that is all of them, nothing changes.
 */
export async function groupChange(userId: string, action: GroupAction): Promise<CommandApplyResult> {
  if (action.tabRefIds.length > MAX_MOVES_PER_CHANGE) return refused("too_many");
  return withChange(userId, async (client) => {
    let workspace: { id: string; name: string };
    let created = false;
    if ("workspaceId" in action.target) {
      const row = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM workspaces WHERE id = $1::uuid AND user_id = $2::uuid AND status <> 'archived'`,
        [action.target.workspaceId, userId],
      );
      if (!row.rows[0]) throw new Refused("not_found");
      workspace = row.rows[0];
    } else {
      const name = action.target.newName.trim();
      const existing = await findExistingWorkspace(client, userId, { name, existingWorkspaceId: null });
      if (existing) workspace = { id: existing.id, name: existing.name };
      else {
        const check = await checkName(client, userId, name);
        if (check !== "ok") throw new Refused(check);
        const id = randomUUID();
        await client.query(`INSERT INTO workspaces (id, user_id, name, emoji, status) VALUES ($1::uuid, $2::uuid, $3, NULL, 'active')`, [id, userId, name]);
        workspace = { id, name };
        created = true;
      }
    }
    const placed = await placeTabs(client, userId, action.tabRefIds, workspace.id);
    if (placed.moves.length === 0) {
      if (created || placed.alreadyThere === 0) throw new Refused("not_found"); // rolls a just-made workspace back too
      return { status: "nothing_to_do", message: m.NOTHING_MOVED, undo: await readUndo(client, userId) };
    }
    return finishChange(client, userId, "group", m.summary.group(placed.moves.length, workspace.name), placed, {
      ...(created ? { createdWorkspaceId: workspace.id } : {}),
      message: m.groupDone(placed.moves.length, workspace.name, placed.alreadyThere, placed.missing),
      workspace,
      counts: { workspacesCreated: created ? 1 : 0 },
    });
  });
}

type MoveAction = Extract<CommandAction, { type: "move" }>;
type RenameAction = Extract<CommandAction, { type: "rename" }>;
type MergeAction = Extract<CommandAction, { type: "merge" }>;

/** An active workspace of the person, locked for this change. */
async function activeWorkspace(client: PoolClient, userId: string, id: string): Promise<{ id: string; name: string } | null> {
  const row = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM workspaces WHERE id = $1::uuid AND user_id = $2::uuid AND status <> 'archived' FOR UPDATE`,
    [id, userId],
  );
  return row.rows[0] ?? null;
}

/** Moves tabs to a named workspace, or back to Other (`null`). Always confirmed before it gets here. */
export async function moveChange(userId: string, action: MoveAction): Promise<CommandApplyResult> {
  if (action.tabRefIds.length > MAX_MOVES_PER_CHANGE) return refused("too_many");
  return withChange(userId, async (client) => {
    let destName = "Other";
    if (action.toWorkspaceId !== null) {
      const dest = await activeWorkspace(client, userId, action.toWorkspaceId);
      if (!dest) throw new Refused("not_found");
      destName = dest.name;
    }
    const placed = await placeTabs(client, userId, action.tabRefIds, action.toWorkspaceId);
    if (placed.moves.length === 0) {
      if (placed.alreadyThere === 0) throw new Refused("not_found");
      return { status: "nothing_to_do", message: m.NOTHING_MOVED, undo: await readUndo(client, userId) };
    }
    return finishChange(client, userId, "move", m.summary.move(placed.moves.length, destName), placed, {
      message: m.moveDone(placed.moves.length, destName, placed.alreadyThere, placed.missing),
      workspace: action.toWorkspaceId === null ? null : { id: action.toWorkspaceId, name: destName },
    });
  });
}

/** Renames a workspace under the same name rules as renaming by hand. Always confirmed before it gets here. */
export async function renameChange(userId: string, action: RenameAction): Promise<CommandApplyResult> {
  return withChange(userId, async (client) => {
    const workspace = await activeWorkspace(client, userId, action.workspaceId);
    if (!workspace) throw new Refused("not_found");
    const name = action.name.trim();
    if (workspace.name === name) return { status: "nothing_to_do", message: m.NAME_UNCHANGED, undo: await readUndo(client, userId) };
    const check = await checkName(client, userId, name, workspace.id); // it may keep its own name in another case
    if (check !== "ok") throw new Refused(check);
    await client.query(`UPDATE workspaces SET name = $3, updated_at = now() WHERE id = $1::uuid AND user_id = $2::uuid`, [workspace.id, userId, name]);
    await recordUndo(client, userId, "rename", m.summary.rename(workspace.name, name), { v: 1, rename: { workspaceId: workspace.id, from: workspace.name, to: name } });
    return {
      status: "done",
      message: m.renameDone(workspace.name, name),
      counts: { ...ZERO },
      undo: await readUndo(client, userId),
      next: null,
      workspace: { id: workspace.id, name },
    };
  });
}

/**
 * Moves EVERY tab of one workspace into another, and nothing else (spec FR-034): the source is not archived,
 * not deleted, and its chat, plan items, and saved agent results are not touched. It is left in place with no
 * tabs. Both must be the person's own active workspaces; a merge into itself is refused before anything runs.
 */
export async function mergeChange(userId: string, action: MergeAction): Promise<CommandApplyResult> {
  if (action.fromWorkspaceId === action.intoWorkspaceId) return refused("same_workspace");
  return withChange(userId, async (client) => {
    // Lock in a fixed order so two merges of the same pair cannot deadlock.
    const [first, second] = [action.fromWorkspaceId, action.intoWorkspaceId].sort();
    const one = await activeWorkspace(client, userId, first);
    const two = await activeWorkspace(client, userId, second);
    if (!one || !two) throw new Refused("not_found");
    const from = action.fromWorkspaceId === one.id ? one : two;
    const into = action.intoWorkspaceId === one.id ? one : two;
    const tabIds = (await client.query<{ id: string }>(`SELECT id FROM tab_refs WHERE user_id = $1::uuid AND workspace_id = $2::uuid ORDER BY id`, [userId, from.id])).rows.map((r) => r.id);
    if (tabIds.length === 0) return { status: "nothing_to_do", message: m.NO_TABS_TO_MERGE, undo: await readUndo(client, userId) };
    if (tabIds.length > MAX_MOVES_PER_CHANGE) throw new Refused("too_many");
    const placed = await placeTabs(client, userId, tabIds, into.id);
    return finishChange(client, userId, "merge", m.summary.merge(from.name, into.name), placed, {
      message: m.mergeDone(placed.moves.length, from.name, into.name, placed.alreadyThere, placed.missing),
      workspace: { id: into.id, name: into.name },
    });
  });
}

// ---------------------------------------------------------------------------------------------------
// Previews: exactly what a confirmed action would change, from the current state.
// ---------------------------------------------------------------------------------------------------

async function tabLines(userId: string, tabs: TabRow[], toName: string): Promise<{ lines: ChangePreview["lines"]; hiddenCount: number }> {
  const names = await workspaceNames({ query }, userId, [...new Set(tabs.map((t) => t.workspaceId).filter((id): id is string => id !== null))]);
  const lines = tabs.slice(0, MAX_PREVIEW_LINES).map((t) => ({
    tabRefId: t.id,
    title: t.title || t.url,
    from: t.workspaceId === null ? "Other" : (names.get(t.workspaceId) ?? "Other"),
    to: toName,
  }));
  return { lines, hiddenCount: Math.max(0, tabs.length - lines.length) };
}

export async function buildPreview(userId: string, action: CommandAction): Promise<ChangePreview> {
  switch (action.type) {
    case "create": {
      const tabs = await readTabs({ query }, userId, action.tabRefIds);
      return { title: m.preview.create(action.name.trim(), tabs.length), ...(await tabLines(userId, tabs, action.name.trim())) };
    }
    case "group": {
      const tabs = await readTabs({ query }, userId, action.tabRefIds);
      const dest = "workspaceId" in action.target ? ((await workspaceNames({ query }, userId, [action.target.workspaceId])).get(action.target.workspaceId) ?? "that workspace") : action.target.newName.trim();
      return { title: m.preview.group(tabs.length, dest), ...(await tabLines(userId, tabs, dest)) };
    }
    case "move": {
      const tabs = await readTabs({ query }, userId, action.tabRefIds);
      const dest = action.toWorkspaceId === null ? "Other" : ((await workspaceNames({ query }, userId, [action.toWorkspaceId])).get(action.toWorkspaceId) ?? "that workspace");
      return { title: m.preview.move(tabs.length, dest), ...(await tabLines(userId, tabs, dest)) };
    }
    case "rename": {
      const from = (await workspaceNames({ query }, userId, [action.workspaceId])).get(action.workspaceId) ?? "that workspace";
      const to = action.name.trim();
      return { title: m.preview.rename(from, to), lines: [{ tabRefId: null, title: "Workspace name", from, to }], hiddenCount: 0 };
    }
    case "merge": {
      const names = await workspaceNames({ query }, userId, [action.fromWorkspaceId, action.intoWorkspaceId]);
      const from = names.get(action.fromWorkspaceId) ?? "that workspace";
      const into = names.get(action.intoWorkspaceId) ?? "that workspace";
      const rows = await query<{ id: string }>(`SELECT id FROM tab_refs WHERE user_id = $1::uuid AND workspace_id = $2::uuid ORDER BY id`, [userId, action.fromWorkspaceId]);
      const tabs = await readTabs({ query }, userId, rows.rows.map((r) => r.id));
      return { title: m.preview.merge(from, into, tabs.length), ...(await tabLines(userId, tabs, into)) };
    }
    default:
      return { title: "", lines: [], hiddenCount: 0 };
  }
}
