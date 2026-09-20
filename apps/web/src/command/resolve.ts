// Turns a validated interpretation into a reply (specs/011-global-command-bar/contracts/http.md,
// "POST /api/command"). This is where the spec's name rules live in ONE place:
//   FR-007  a workspace named in a command matches only the person's own workspaces; one match
//           resolves, two or more become a question, none is said plainly (never a guess);
//   FR-008  "this workspace" is the active tab's workspace on a page and the single expanded card on
//           Home, resolved from context here and never by the model.
// Every sentence comes from messages.ts. Nothing here writes to the database.
import type { CommandAction, CommandChoice, CommandContext, CommandIntent, CommandReply } from "@ai-browser/shared";
import { getAgent } from "../agents/catalog";
import { readCandidates } from "../cluster/run";
import { findExistingWorkspace } from "../cluster/target";
import { buildFound } from "./find";
import { resolvePeriod } from "./period";
import { recallActivity } from "./recall";
import { activeTabRow, readTabs, theseTabs, type Current, type Db, type TabRow, type WorkspaceRow } from "./context";
import { CONFIDENCE_BAR, MAX_MOVES_PER_CHANGE, MAX_TEXT_CHARS } from "./limits";
import * as m from "./messages";
import type { Material } from "./prompt";
import type { Interpretation } from "./validate";

export const say = (message: string, help: string[] | null = null): CommandReply => ({ kind: "say", message, help });
export const ask = (question: string, choices: CommandChoice[]): CommandReply => ({ kind: "ask", question, choices });
export const choice = (label: string, step: CommandChoice["step"]): CommandChoice => ({ label, step });
export const actionReply = (understood: string, action: CommandAction): CommandReply => ({ kind: "action", understood, action });

/** Everything a handler may read. Handlers never write. */
export interface ResolveCtx {
  userId: string;
  db: Db;
  text: string;
  context: CommandContext;
  interp: Interpretation;
  material: Material;
  current: Current;
  now: Date;
  /** Active workspaces the model was shown, by real id (name), in list order. */
  workspaces: WorkspaceRow[];
  wsNames: Map<string, string>;
}

export type Handler = (ctx: ResolveCtx) => Promise<CommandReply>;

export type WorkspaceRef =
  | { kind: "one"; workspace: WorkspaceRow }
  | { kind: "many"; workspaces: WorkspaceRow[] }
  | { kind: "none-named" }
  | { kind: "current-unresolved"; why: "none" | "several" | "other" }
  | { kind: "not-named" };

/**
 * FR-007 and FR-008. `ids` are the workspaces the model said the phrase could mean (already checked to
 * be the person's own); `named` is whether the person named one at all; `useCurrent` is "this workspace".
 */
export function resolveWorkspaceRef(
  ids: string[],
  named: boolean,
  useCurrent: boolean,
  current: Current,
  wsNames: Map<string, string>,
): WorkspaceRef {
  if (useCurrent) {
    if (current.kind === "workspace") return { kind: "one", workspace: current.workspace };
    return { kind: "current-unresolved", why: current.kind };
  }
  const found = ids.filter((id) => wsNames.has(id)).map((id) => ({ id, name: wsNames.get(id)! }));
  if (found.length === 1) return { kind: "one", workspace: found[0] };
  if (found.length > 1) return { kind: "many", workspaces: found };
  return named ? { kind: "none-named" } : { kind: "not-named" };
}

/**
 * The plain answer for a reference that did not resolve to one workspace (nothing ran). When two match, the
 * question has one button per workspace; `stepFor` says what a button does (navigate by default).
 */
export function unresolvedReply(
  ref: Exclude<WorkspaceRef, { kind: "one" }>,
  ctx: ResolveCtx,
  stepFor: (workspace: WorkspaceRow) => CommandChoice["step"] = (w) => ({ kind: "navigate", target: { kind: "workspace", workspaceId: w.id } }),
): CommandReply {
  switch (ref.kind) {
    case "none-named":
    case "not-named":
      return say(m.noWorkspaceLike([...ctx.wsNames.values()].slice(0, 12)));
    case "current-unresolved":
      return say(ref.why === "several" ? m.CURRENT_SEVERAL : m.CURRENT_NONE);
    case "many":
      return ask(m.WHICH_WORKSPACE, ref.workspaces.map((w) => choice(w.name, stepFor(w))));
  }
}

/** Organize: count the loose tabs (the same candidates Home's organize uses) and say what will happen. */
const organize: Handler = async (ctx) => {
  const { total } = await readCandidates(ctx.db, ctx.userId);
  if (total === 0) return say(m.NO_LOOSE_TABS);
  return actionReply(m.understood.organize(total), { type: "organize" });
};

/** Show Home: changes only what is on screen. */
const show: Handler = async () => ({ kind: "navigate", understood: m.understood.show(), target: { kind: "home" } });

/** Open a named (or "this") workspace: Home comes forward with that card shown. */
const openWorkspace: Handler = async (ctx) => {
  const ref = resolveWorkspaceRef(ctx.interp.subject, ctx.interp.subjectNamed, ctx.interp.thisWorkspace, ctx.current, ctx.wsNames);
  if (ref.kind === "one") {
    return { kind: "navigate", understood: m.understood.open(ref.workspace.name), target: { kind: "workspace", workspaceId: ref.workspace.id } };
  }
  return unresolvedReply(ref, ctx);
};

/**
 * Create a workspace. The tabs are the ones the command described, or "these tabs" (the default when none
 * were described: the loose tabs on Home, this window's loose tabs on a page), or "this tab". The name is the
 * one the person gave (checked by `usableName`), else one drawn from the tabs. A name already in use makes
 * nothing: it offers to add the tabs to that workspace instead (a `move`, which confirms).
 */
const create: Handler = async (ctx) => {
  const { interp, db, userId } = ctx;
  let tabs: TabRow[];
  if (interp.tabs.length > 0) tabs = await readTabs(db, userId, interp.tabs);
  else if (interp.scope === "this_tab") {
    const active = await activeTabRow(db, userId, ctx.context);
    tabs = active ? [active] : [];
  } else tabs = await theseTabs(db, userId, ctx.context, "create", ctx.current);
  if (tabs.length === 0) return say(m.NO_TABS_FOR_CREATE);
  if (tabs.length > MAX_MOVES_PER_CHANGE) return say(m.REFUSAL.too_many);
  if (!interp.name) return say(m.NO_NAME);
  const ids = tabs.map((t) => t.id);
  const existing = await findExistingWorkspace(db, userId, { name: interp.name, existingWorkspaceId: null });
  if (existing) {
    return ask(m.NAME_EXISTS_QUESTION, [choice(`Add to ${existing.name}`, { kind: "action", action: { type: "move", tabRefIds: ids, toWorkspaceId: existing.id } })]);
  }
  return actionReply(m.understood.create(interp.name, tabs.length), { type: "create", name: interp.name, tabRefIds: ids });
};

/**
 * Run one of the five workspace agents (feature 010). This only says WHICH agent for WHICH workspace: the
 * client presses the 010 route itself, the same route and function the Home card uses, so there is no second
 * agent stack. With no workspace named it means the current one ("summarize" on a page).
 */
const agent: Handler = async (ctx) => {
  const def = ctx.interp.agent ? getAgent(ctx.interp.agent) : undefined;
  if (!def) return say(m.CANT_DO, [...m.HELP]);
  const { interp } = ctx;
  const useCurrent = interp.thisWorkspace || (interp.subject.length === 0 && !interp.subjectNamed);
  const ref = resolveWorkspaceRef(interp.subject, interp.subjectNamed, useCurrent, ctx.current, ctx.wsNames);
  const press = (workspaceId: string): CommandAction => ({ type: "agent", workspaceId, agentId: def.id });
  if (ref.kind === "one") return actionReply(m.understood.agent(def.name, ref.workspace.name), press(ref.workspace.id));
  if (ref.kind === "current-unresolved" && ref.why === "other") {
    // The page is in no workspace: pick one of the person's, or make one from these tabs.
    const picks = ctx.workspaces.slice(0, 4).map((w) => choice(w.name, { kind: "action", action: press(w.id) }));
    return ask(m.CURRENT_OTHER_QUESTION, [...picks, choice("create a workspace for these tabs", { kind: "submit", text: "create a workspace for these tabs" })]);
  }
  return unresolvedReply(ref, ctx, (w) => ({ kind: "action", action: press(w.id) }));
};

/**
 * Move tabs to a named workspace, or back to Other. The tabs are the ones the command described, "these"
 * (the current workspace's tabs), or "this tab". Two matching destinations ask which. The action always asks
 * for confirmation on apply, with the exact tabs listed.
 */
const move: Handler = async (ctx) => {
  const { interp, db, userId } = ctx;
  let tabs: TabRow[];
  if (interp.tabs.length > 0) tabs = await readTabs(db, userId, interp.tabs);
  else if (interp.scope === "these_tabs") {
    if (ctx.current.kind !== "workspace") return say(ctx.current.kind === "several" ? m.CURRENT_SEVERAL : m.CURRENT_NONE);
    tabs = await theseTabs(db, userId, ctx.context, "move", ctx.current);
  } else if (interp.scope === "this_tab") {
    const active = await activeTabRow(db, userId, ctx.context);
    tabs = active ? [active] : [];
  } else tabs = [];
  if (tabs.length === 0) return say(m.NO_MATCHING_TABS);
  if (tabs.length > MAX_MOVES_PER_CHANGE) return say(m.REFUSAL.too_many);
  const ids = tabs.map((t) => t.id);
  const moveTo = (toWorkspaceId: string | null): CommandAction => ({ type: "move", tabRefIds: ids, toWorkspaceId });
  if (interp.toOther) return actionReply(m.understood.move(ids.length, "Other"), moveTo(null));
  const dest = resolveWorkspaceRef(interp.destination, interp.destinationNamed, false, ctx.current, ctx.wsNames);
  if (dest.kind === "one") return actionReply(m.understood.move(ids.length, dest.workspace.name), moveTo(dest.workspace.id));
  return unresolvedReply(dest, ctx, (w) => ({ kind: "action", action: moveTo(w.id) }));
};

/** Rename a named (or the current) workspace. The new name is checked by `usableName`; the server enforces uniqueness. */
const rename: Handler = async (ctx) => {
  const { interp } = ctx;
  const useCurrent = interp.thisWorkspace || (interp.subject.length === 0 && !interp.subjectNamed);
  const ref = resolveWorkspaceRef(interp.subject, interp.subjectNamed, useCurrent, ctx.current, ctx.wsNames);
  const name = interp.name;
  const renameTo = (id: string): CommandAction => ({ type: "rename", workspaceId: id, name: name! });
  if (ref.kind !== "one") return unresolvedReply(ref, ctx, (w) => ({ kind: "action", action: renameTo(w.id) }));
  if (!name) return say(m.NO_NAME_TO_RENAME);
  return actionReply(m.understood.rename(ref.workspace.name, name), renameTo(ref.workspace.id));
};

/**
 * Merge one workspace into another: only tabs move. With one side ambiguous the question is about that side;
 * with both ambiguous, the person is asked for exact names. Merging a workspace into itself is said plainly.
 */
const merge: Handler = async (ctx) => {
  const { interp } = ctx;
  const fromCurrent = interp.thisWorkspace || (interp.subject.length === 0 && !interp.subjectNamed);
  const from = resolveWorkspaceRef(interp.subject, interp.subjectNamed, fromCurrent, ctx.current, ctx.wsNames);
  const into = resolveWorkspaceRef(interp.destination, interp.destinationNamed, false, ctx.current, ctx.wsNames);
  const mergeAction = (fromId: string, intoId: string): CommandAction => ({ type: "merge", fromWorkspaceId: fromId, intoWorkspaceId: intoId });
  if (from.kind === "many" && into.kind === "many") return say(m.BOTH_AMBIGUOUS);
  if (from.kind === "many" && into.kind === "one") return unresolvedReply(from, ctx, (w) => ({ kind: "action", action: mergeAction(w.id, into.workspace.id) }));
  if (into.kind === "many" && from.kind === "one") return unresolvedReply(into, ctx, (w) => ({ kind: "action", action: mergeAction(from.workspace.id, w.id) }));
  if (from.kind !== "one") return unresolvedReply(from, ctx);
  if (into.kind !== "one") return unresolvedReply(into, ctx);
  if (from.workspace.id === into.workspace.id) return say(m.SAME_WORKSPACE);
  return actionReply(m.understood.merge(from.workspace.name, into.workspace.name), mergeAction(from.workspace.id, into.workspace.id));
};

/**
 * Put described tabs together. At least two tabs must match. The target is the destination the person
 * named (two matches ask which), else an existing workspace with the name the model gave, else a new one.
 * The action always asks for confirmation on apply, with the exact tabs listed.
 */
const groupTabs: Handler = async (ctx) => {
  const { interp, db, userId } = ctx;
  const tabs = interp.tabs.length > 0 ? await readTabs(db, userId, interp.tabs) : [];
  if (tabs.length < 2) return say(m.NO_MATCHING_TABS);
  const ids = tabs.map((t) => t.id);
  const dest = resolveWorkspaceRef(interp.destination, interp.destinationNamed, false, ctx.current, ctx.wsNames);
  const group = (target: { workspaceId: string } | { newName: string }): CommandAction => ({ type: "group", tabRefIds: ids, target });
  if (dest.kind === "one") return actionReply(m.understood.group(ids.length, dest.workspace.name), group({ workspaceId: dest.workspace.id }));
  if (dest.kind === "many" || dest.kind === "none-named") return unresolvedReply(dest, ctx, (w) => ({ kind: "action", action: group({ workspaceId: w.id }) }));
  if (!interp.name) return say(m.NO_NAME);
  const existing = await findExistingWorkspace(db, userId, { name: interp.name, existingWorkspaceId: null });
  if (existing) return actionReply(m.understood.group(ids.length, existing.name), group({ workspaceId: existing.id }));
  return actionReply(m.understood.group(ids.length, interp.name), group({ newName: interp.name }));
};

/** Clean up: organize the loose tabs, then the extension offers the exact duplicates. Never refused for "no loose tabs". */
const cleanup: Handler = async (ctx) => {
  const { total } = await readCandidates(ctx.db, ctx.userId);
  return actionReply(m.understood.cleanup(total), { type: "cleanup" });
};

/**
 * "What was I working on yesterday?": read-only, from the recorded tab activity, in the person's own time
 * zone. Nothing recorded for the period is said plainly (never guessed); a day that has not happened is said too.
 */
const recall: Handler = async (ctx) => {
  const period = ctx.interp.period;
  if (!period) return say(m.NO_PERIOD);
  const range = resolvePeriod(period, ctx.now, ctx.context.timeZone);
  if ("future" in range) return say(m.FUTURE_DAY);
  const workspaces = await recallActivity(ctx.db, ctx.userId, range);
  if (workspaces.length === 0) return say(m.nothingRecorded(range.label));
  return { kind: "recalled", understood: m.understood.recall(range.label), periodLabel: range.label, workspaces };
};

/**
 * Find tabs or workspaces by description, among the person's own saved titles, addresses, and excerpts (archived
 * workspaces are not searched). Read-only, no page is fetched. The reply says how many more the model ranked
 * beyond the eight shown, and says so only when the material itself was cut.
 */
const find: Handler = async (ctx) => {
  const found = await buildFound(ctx.db, ctx.userId, ctx.interp.tabs, ctx.interp.workspaces);
  if (found.tabs.length === 0 && found.workspaces.length === 0) return say(m.FIND_NOTHING);
  const cut = ctx.material.cut;
  return { kind: "found", understood: m.understood.find(), ...found, cutNote: cut ? m.cutNote(cut.shown, cut.total) : null };
};

/** Undo the most recent change. The server does it on apply; this only says so. */
const undo: Handler = async () => actionReply(m.understood.undo(), { type: "undo" });

/** Handlers for the intents that act; the stories add theirs here. */
export const HANDLERS: Partial<Record<CommandIntent, Handler>> = {
  organize,
  show,
  open_workspace: openWorkspace,
  create,
  agent,
  group: groupTabs,
  cleanup,
  move,
  rename,
  merge,
  undo,
  recall,
  find,
};

/**
 * `multiple`, `clarify`, `unsupported`, low confidence, or an intent with no handler: NOTHING runs.
 *   - multiple: one button per piece of the person's own words (the validator kept only verbatim pieces);
 *     a button submits that piece as a NEW command;
 *   - clarify / unsure: buttons for fixed phrases the model only chose by key;
 *   - unsupported: a plain refusal with what the bar can do; a question about what is inside a page offers
 *     to find the tab (a fixed prefix plus the person's own words), because that is what the bar can do.
 * No model-written text reaches any button.
 */
async function fallback(ctx: ResolveCtx): Promise<CommandReply> {
  const { interp } = ctx;
  if (interp.intent === "multiple") {
    if (interp.parts.length === 0) return say(m.ONE_THING_NO_PARTS, [...m.HELP]);
    return ask(m.ONE_THING, interp.parts.map((part) => choice(part, { kind: "submit", text: part })));
  }
  if (interp.intent === "unsupported") {
    if (interp.reason === "page_content") {
      return ask(m.PAGE_CONTENT_QUESTION, [choice(m.FIND_THE_TAB, { kind: "submit", text: `${m.FIND_PREFIX}${ctx.text}`.slice(0, MAX_TEXT_CHARS) })]);
    }
    return say(m.CANT_DO, [...m.HELP]);
  }
  if (interp.alternatives.length > 0) {
    return ask(m.NOT_SURE_QUESTION, interp.alternatives.map((key) => choice(m.ALTERNATIVE_PHRASES[key], { kind: "submit", text: m.ALTERNATIVE_PHRASES[key] })));
  }
  return say(m.NOT_SURE, [...m.HELP]);
}

export async function resolveInterpretation(ctx: ResolveCtx): Promise<CommandReply> {
  const { intent, confidence } = ctx.interp;
  const acting = intent !== "clarify" && intent !== "multiple" && intent !== "unsupported";
  if (acting && confidence < CONFIDENCE_BAR) return fallback({ ...ctx, interp: { ...ctx.interp, intent: "clarify" } });
  if (!acting) return fallback(ctx);
  const handler = HANDLERS[intent as CommandIntent];
  return handler ? handler(ctx) : fallback(ctx);
}
