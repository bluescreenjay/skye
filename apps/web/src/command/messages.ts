// EVERY sentence a person can see from the command bar (specs/011-global-command-bar/research.md 1).
// The model never writes one: a reply is a fixed template filled with values the server has checked
// (counts, workspace names and tab titles read from the database). A workspace name or a tab title
// is the only free text a template takes, and the client renders it as plain text.
//
// The list of example commands is a literal copy of COMMAND_EXAMPLES in @ai-browser/shared: server
// code imports only types from the shared package (a runtime import would need `transpilePackages`),
// and tests/command-validate.test.ts asserts the two lists are equal.
import type { CommandRefusalCode } from "@ai-browser/shared";

export const HELP: readonly string[] = [
  "organize my tabs",
  "create a workspace for these tabs",
  "put my shopping tabs together",
  "clean up my browser",
  "what was I working on yesterday?",
  "summarize this workspace",
];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export const tabs = (n: number) => plural(n, "tab", "tabs");
export const workspaces = (n: number) => plural(n, "workspace", "workspaces");
const leftAs = (n: number) => `${n} left as ${n === 1 ? "a suggestion" : "suggestions"}.`;
const q = (name: string) => name; // names are shown as they are; kept as a hook for one place to change quoting

// --- request errors ---
export const TEXT_EMPTY = "Type a command first.";
export const TEXT_TOO_LONG = "That command is too long. Shorten it and try again.";
export const BAD_CONTEXT = "Something went wrong reading where you are. Try again.";
export const BAD_TIME_ZONE = BAD_CONTEXT;
export const BAD_ACTION = "That isn't something I can run.";
export const CONFIRMATION_REQUIRED = "That change needs your confirmation first.";
export const COMMAND_FAILED = "The command failed";

// --- the AI service failing (interpret) ---
export const AI_UNCONFIGURED = "The AI assistant isn't set up on this server yet.";
export const AI_DAILY = "The daily AI limit has been reached. Try again tomorrow.";
export const AI_QUOTA = "The AI service's quota has been reached. Try again later.";
export const AI_BUSY = "The AI assistant is busy right now. Try again in a moment.";
export const AI_VPN = "The AI service is only reachable on the VT VPN. Connect to it and try again.";
export const AI_FAILED = "The AI assistant couldn't understand that right now. Your words are still here; try again.";

// --- what was understood, shown as a command starts (FR-009) ---
export const understood = {
  organize: (n: number) => `Organizing your ${n} loose ${n === 1 ? "tab" : "tabs"}.`,
  cleanup: (n: number) =>
    n > 0
      ? `Cleaning up: organizing your ${n} loose ${n === 1 ? "tab" : "tabs"}, then looking for duplicate tabs.`
      : "Cleaning up: looking for duplicate tabs.",
  group: (n: number, dest: string) => `Putting ${tabs(n)} together in ${q(dest)}.`,
  move: (n: number, dest: string) => `Moving ${tabs(n)} to ${q(dest)}.`,
  rename: (from: string, to: string) => `Renaming ${q(from)} to ${q(to)}.`,
  merge: (from: string, into: string) => `Merging ${q(from)} into ${q(into)}.`,
  create: (name: string, n: number) => `Creating ${q(name)} with ${tabs(n)}.`,
  agent: (agent: string, workspace: string) => `Running ${agent} for ${q(workspace)}.`,
  undo: () => "Undoing your last change.",
  show: () => "Showing your workspaces.",
  open: (name: string) => `Opening ${q(name)}.`,
  find: () => "Looking for your tabs matching that.",
  recall: (label: string) => `Looking at what you were working on ${label}.`,
};

// --- plain answers where nothing ran ---
export const CANT_DO = "I can't do that.";
export const NOT_SURE = "I wasn't sure what you meant.";
export const NO_LOOSE_TABS = "There are no loose tabs to organize.";
export const NO_MATCHING_TABS = "No open tabs match that.";
export const NO_WORKSPACES_YET = "You don't have any workspaces yet.";
export const noWorkspaceLike = (names: string[]) =>
  names.length === 0
    ? `I couldn't find a workspace like that. ${NO_WORKSPACES_YET}`
    : `I couldn't find a workspace like that. Yours are: ${names.map(q).join(", ")}.`;
export const CURRENT_NONE = "I'm not sure which workspace you mean. Open one on Home, or click into a page that is in one, then try again.";
export const CURRENT_SEVERAL = "More than one workspace is open, so I can't tell which you mean. Name it.";
export const CURRENT_OTHER_QUESTION = "This tab isn't in a workspace yet. Pick one, or make one.";
export const nameTaken = (name: string) => `A workspace named ${q(name)} already exists.`;
export const NAME_RESERVED = "“Other” is kept for tabs that aren't in a workspace. Pick another name.";
export const NAME_BAD = "A workspace name needs 1 to 80 characters.";
export const SAME_WORKSPACE = "A workspace can't be merged into itself.";
export const NOTHING_TO_UNDO = "There is nothing to undo.";
export const NO_NAME = "I couldn't tell what to call it. Say “create a workspace called …”.";
export const NO_NAME_TO_RENAME = "What should it be called? Say “rename this workspace to …”.";
export const NO_TABS_FOR_CREATE = "There are no tabs to put in it.";
export const NO_PERIOD = "I couldn't tell what time you meant. Try “yesterday” or “last week”.";
export const nothingRecorded = (label: string) => `Nothing was recorded for ${label}.`;
export const FUTURE_DAY = "That day hasn't happened yet.";
export const FIND_NOTHING = "Nothing matched. Try different words.";
export const cutNote = (shown: number, total: number) => `Looked at your ${shown} most recent of ${total} tabs.`;
export const BOTH_AMBIGUOUS = "Please name the workspaces more exactly.";

// --- questions ---
export const WHICH_WORKSPACE = "Which workspace do you mean?";
export const ONE_THING = "I do one thing at a time. Which first?";
export const ONE_THING_NO_PARTS = "I do one thing at a time. Try one command at a time.";
export const PAGE_CONTENT_QUESTION = "I can find your tabs, but I can't answer questions about what's inside them.";
export const NAME_EXISTS_QUESTION = "That workspace already exists. Add these tabs to it instead?";
export const NOT_SURE_QUESTION = "I wasn't sure what you meant. Did you mean one of these?";
export const FIND_THE_TAB = "Find the tab";
export const FIND_PREFIX = "find the tab: ";
/** Fixed phrases for the "did you mean" buttons: the model only picks the key. */
export const ALTERNATIVE_PHRASES = {
  organize: "organize my tabs",
  cleanup: "clean up my browser",
  create: "create a workspace for these tabs",
  show: "show my workspaces",
} as const;

// --- apply: results ---
export const NOTHING_TO_ORGANIZE = "Nothing to organize.";
export const suggestionsLeft = (n: number) => leftAs(n);
export const CLEANUP_NOTHING_ORGANIZED = "Nothing to organize. Now looking for duplicate tabs.";
/** `groups` is how many workspaces the run put tabs into (new or existing). */
export const organizeDone = (moved: number, groups: number, sug: number) => {
  const head = `Moved ${tabs(moved)} into ${workspaces(groups)}.`;
  return sug > 0 ? `${head} ${leftAs(sug)}` : head;
};
const tail = (already: number, missing: number) =>
  `${already > 0 ? ` ${already} already there.` : ""}${missing > 0 ? ` ${missing} no longer ${missing === 1 ? "exists" : "exist"}.` : ""}`;
export const moveDone = (moved: number, dest: string, already: number, missing: number) =>
  `Moved ${tabs(moved)} to ${q(dest)}.${tail(already, missing)}`;
export const groupDone = (moved: number, dest: string, already: number, missing: number) =>
  `Put ${tabs(moved)} together in ${q(dest)}.${tail(already, missing)}`;
export const createDone = (name: string, moved: number, already: number, missing: number) =>
  `Created ${q(name)} with ${tabs(moved)}.${tail(already, missing)}`;
export const renameDone = (from: string, to: string) => `Renamed ${q(from)} to ${q(to)}.`;
export const mergeDone = (moved: number, from: string, into: string, already: number, missing: number) =>
  `Moved ${tabs(moved)} from ${q(from)} into ${q(into)}.${tail(already, missing)} ${q(from)} still exists, with its chat and results, but has no tabs now.`;
export const NOTHING_MOVED = "Those tabs are already there.";
export const NAME_UNCHANGED = "It already has that name.";
export const NO_TABS_TO_MERGE = "That workspace has no tabs to move.";

// --- the one-line summaries kept for Undo (never a tab title) ---
export const summary = {
  organize: (moved: number, groups: number) => `organized ${tabs(moved)}${groups > 0 ? ` into ${workspaces(groups)}` : ""}`,
  move: (moved: number, dest: string) => `moved ${tabs(moved)} to ${q(dest)}`,
  group: (moved: number, dest: string) => `put ${tabs(moved)} together in ${q(dest)}`,
  create: (name: string, moved: number) => `created ${q(name)} with ${tabs(moved)}`,
  rename: (from: string, to: string) => `renamed ${q(from)} to ${q(to)}`,
  merge: (from: string, into: string) => `merged ${q(from)} into ${q(into)}`,
};

// --- undo results ---
export const undoDone = (reverted: number, kept: number) =>
  `Undone.${reverted > 0 ? ` Put ${tabs(reverted)} back.` : ""}${kept > 0 ? ` ${tabs(kept)} kept where you put ${kept === 1 ? "it" : "them"}.` : ""}`;
export const undoRenamed = (name: string) => `Undone. Renamed it back to ${q(name)}.`;
export const undoRenameKept = "Kept the current name, because it changed since.";
export const UNDO_WORKSPACE_KEPT = "The new workspace was kept because you've started using it.";

// --- preview titles ---
export const preview = {
  move: (n: number, dest: string) => `Move ${tabs(n)} to ${q(dest)}`,
  group: (n: number, dest: string) => `Put ${tabs(n)} together in ${q(dest)}`,
  create: (name: string, n: number) => `Create ${"“"}${q(name)}${"”"} with ${tabs(n)}`,
  rename: (from: string, to: string) => `Rename ${q(from)} to ${q(to)}`,
  merge: (from: string, into: string, n: number) => `Merge ${q(from)} into ${q(into)} (${tabs(n)} will move)`,
};

// --- apply: refusals ---
export const REFUSAL: Record<CommandRefusalCode, string> = {
  not_found: "That workspace or those tabs changed. Ask again.",
  name_taken: "That name is already in use.",
  reserved_name: NAME_RESERVED,
  same_workspace: SAME_WORKSPACE,
  too_many: "That is too many tabs for one change. Try a smaller set.",
  run_in_progress: "Already organizing.",
  budget_exhausted: AI_DAILY,
  model_error: "The AI assistant couldn't organize right now. Try again.",
  model_unconfigured: AI_UNCONFIGURED,
};
