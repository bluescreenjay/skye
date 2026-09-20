// The client side of the command bar (feature 011: specs/011-global-command-bar/contracts/extension.md).
// Pure logic, no React and nothing that touches the browser: a small client that never throws (every way
// a request can end is a value), the helpers the bar uses, and the bar's state machine as one pure reducer.
// Replies, previews, and results are only ever handed back as plain strings; the bar draws them as text,
// never as HTML, markdown, links, or images (shared-command-types rule 1).
//
// Two rules the reducer keeps (spec FR-003, FR-026):
//   - whether the bar is OPEN is separate from what it is DOING, so closing it never cancels or clears
//     anything that is running or finished;
//   - a failure never replaces the typed text.
import type {
  ChangePreview,
  CommandAction,
  CommandApplyResult,
  CommandChoice,
  CommandContext,
  CommandReply,
  CommandRequest,
  FoundTab,
  NavTarget,
  TabRef,
  UndoState,
} from "@ai-browser/shared";
import { COMMAND_EXAMPLES } from "@ai-browser/shared";
import type { Config } from "../config";
import { describeRunOutcome, POLL_MS, pressAgent, readAgents, resultText } from "./agents";
import { sendSignal } from "./command-signal";

export const EXAMPLES: readonly string[] = COMMAND_EXAMPLES;

/** A command longer than this is cut, visibly, before it is sent (FR-027). */
export const COMMAND_MAX_CHARS = 300;
/** How long the bar waits for an agent it started before saying it is still running. */
export const AGENT_WAIT_MS = 90_000;

export const SHORTENED_NOTE = `Shortened to ${COMMAND_MAX_CHARS} characters.`;
export const UNREACHABLE_MESSAGE = "Can't reach the server.";
export const UNPAIRED_MESSAGE = "This browser isn't connected yet.";
export const GENERIC_MESSAGE = "Something went wrong. Try again.";
export const PAIRING_MESSAGE = "Pairing failed. Check your device token.";
export const ALREADY_RUNNING_MESSAGE = "That agent is already running for this workspace.";
export const STILL_RUNNING_MESSAGE = "Still running. The result will appear on the workspace card.";
export const LOST_TOUCH_MESSAGE = "Can't reach the server. The run carries on there; its result will appear on the workspace card.";
/** "Closed 2 tabs." plus how many were left alone because they changed since the list was made. */
export function closedMessage(closed: number, skipped: number): string {
  const head = closed > 0 ? `Closed ${closed} ${closed === 1 ? "tab" : "tabs"}.` : "No tabs were closed.";
  return skipped > 0 ? `${head} ${skipped} skipped because ${skipped === 1 ? "it" : "they"} changed.` : head;
}

/** How many lines of a result the bar shows; the full one is on the workspace card. */
export const AGENT_RESULT_LINES = 6;

const AGENT_NAMES: Record<string, string> = { summarize: "summarize", compare: "compare", missing: "what's missing", "next-steps": "next steps", refs: "collect refs" };
export const agentName = (agentId: string): string => AGENT_NAMES[agentId] ?? agentId;

/** Trims and cuts the text; says whether it cut. Nothing is ever sent longer than the limit. */
export function clipCommand(text: string): { text: string; cut: boolean } {
  const trimmed = text.trim();
  return trimmed.length > COMMAND_MAX_CHARS ? { text: trimmed.slice(0, COMMAND_MAX_CHARS), cut: true } : { text: trimmed, cut: false };
}

// ---------------------------------------------------------------------------------------------------
// The host: how the bar reaches the browser. Implemented by Home and the Side Panel (home/command-host.ts).
// ---------------------------------------------------------------------------------------------------

/** Exact-address duplicates among live tabs, with the copy to keep in each group. */
export interface DuplicatePlan {
  groups: { url: string; title: string; keep: number; close: number[] }[];
  totalToClose: number;
}

export interface CommandHost {
  surface: "home" | "page";
  /** Read fresh at submit time. */
  getContext(): Promise<CommandContext>;
  /** Home reloads its directory; the sidebar reloads its view. Called after a change. */
  refresh(): void;
  /** Bring Home forward; with a workspace, expand its card. */
  showHome(target: NavTarget): Promise<void>;
  /** Focus an open tab, or open its address in a new tab. */
  openTab(tab: TabRef): Promise<void>;
  /** The exact-address duplicates among live tabs, with the copy to keep. */
  scanDuplicates(): Promise<DuplicatePlan>;
  /** Re-checks each tab, closes only the extras that still match, returns counts. */
  closeDuplicates(plan: DuplicatePlan): Promise<{ closed: number; skipped: number }>;
}

// ---------------------------------------------------------------------------------------------------
// The client. It never throws.
// ---------------------------------------------------------------------------------------------------

export interface CommandRequestOptions {
  signal?: AbortSignal;
  /** Tests only. */
  fetchImpl?: typeof fetch;
}

export type ClientResult<T> =
  | { kind: "ok"; value: T }
  /** The server answered with a refusal (a fixed sentence). */
  | { kind: "refused"; status: number; code: string | null; message: string }
  | { kind: "unreachable" }
  | { kind: "unpaired" };

const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const isString = (value: unknown): value is string => typeof value === "string";

const REPLY_KINDS = new Set(["action", "navigate", "found", "recalled", "say", "ask"]);
const APPLY_STATUSES = new Set(["needs_confirmation", "done", "nothing_to_do", "refused"]);

async function send<T>(
  config: Config | null,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  /** Returns the value in a box, or null when the body is not what was promised (a null VALUE is a valid answer). */
  accept: (json: Record<string, unknown>) => { value: T } | null,
  options: CommandRequestOptions,
): Promise<ClientResult<T>> {
  if (!config) return { kind: "unpaired" };
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${config.apiBaseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${config.deviceToken}`, "Content-Type": "application/json" },
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal: options.signal,
    });
  } catch {
    return { kind: "unreachable" };
  }
  let json: Record<string, unknown> = {};
  try {
    json = asObject(await response.json());
  } catch {
    // A non-JSON body is handled below.
  }
  if (response.ok) {
    const accepted = accept(json);
    if (accepted !== null) return { kind: "ok", value: accepted.value };
    return { kind: "refused", status: response.status, code: null, message: GENERIC_MESSAGE }; // never invent a result
  }
  const code = isString(json.code) ? json.code : null;
  const message = response.status === 401 ? PAIRING_MESSAGE : isString(json.error) && json.error.trim() && code !== null ? json.error.trim() : GENERIC_MESSAGE;
  return { kind: "refused", status: response.status, code, message };
}

/** POST /api/command: the one AI request. */
export function interpretCommand(config: Config | null, request: CommandRequest, options: CommandRequestOptions = {}): Promise<ClientResult<CommandReply>> {
  return send(config, "POST", "/api/command", request, (json) => (isString(json.kind) && REPLY_KINDS.has(json.kind) ? { value: json as unknown as CommandReply } : null), options);
}

/** POST /api/command/apply. */
export function applyCommand(config: Config | null, action: CommandAction, confirmed: boolean, options: CommandRequestOptions = {}): Promise<ClientResult<CommandApplyResult>> {
  return send(config, "POST", "/api/command/apply", { action, confirmed }, (json) => (isString(json.status) && APPLY_STATUSES.has(json.status) ? { value: json as unknown as CommandApplyResult } : null), options);
}

function isUndoState(value: unknown): value is UndoState {
  const u = asObject(value);
  return isString(u.kind) && isString(u.summary) && isString(u.expiresAt);
}

/** GET /api/command/undo: what can be undone right now (`null` when nothing can). */
export function readUndo(config: Config | null, options: CommandRequestOptions = {}): Promise<ClientResult<UndoState | null>> {
  return send(config, "GET", "/api/command/undo", undefined, (json) => (json.undo === null ? { value: null } : isUndoState(json.undo) ? { value: json.undo } : null), options);
}

// ---------------------------------------------------------------------------------------------------
// Text helpers.
// ---------------------------------------------------------------------------------------------------

/** "Undo: moved 3 tabs into Kyoto trip". */
export function describeUndo(undo: UndoState): string {
  return `Undo: ${undo.summary}`;
}

/** The message for a client result that is not `ok`. Never a result; always a plain sentence. */
export function failureMessage(result: Exclude<ClientResult<unknown>, { kind: "ok" }>): string {
  if (result.kind === "unreachable") return UNREACHABLE_MESSAGE;
  if (result.kind === "unpaired") return UNPAIRED_MESSAGE;
  return result.message;
}

// ---------------------------------------------------------------------------------------------------
// The bar's state machine.
// ---------------------------------------------------------------------------------------------------

/** What the bar is showing below the box. */
export type BarView =
  | { kind: "idle" }
  | { kind: "interpreting" }
  /** A command has started: what it understood, while the change or the run goes on. */
  | { kind: "running"; understood: string }
  | { kind: "confirming"; understood: string; action: CommandAction; preview: ChangePreview }
  | { kind: "done"; message: string; workspace: { id: string; name: string } | null }
  /** Plain message, nothing ran. */
  | { kind: "say"; message: string; help: string[] | null }
  | { kind: "ask"; question: string; choices: CommandChoice[] }
  | { kind: "found"; understood: string; tabs: FoundTab[]; workspaces: Extract<CommandReply, { kind: "found" }>["workspaces"]; more: number; cutNote: string | null }
  | { kind: "recalled"; understood: string; periodLabel: string; workspaces: Extract<CommandReply, { kind: "recalled" }>["workspaces"] }
  | { kind: "agent"; understood: string; workspaceId: string; phase: "running" | "result" | "still" | "failed"; lines: string[]; message: string | null }
  | { kind: "duplicates"; plan: DuplicatePlan; closing: boolean }
  | { kind: "failed"; message: string };

export interface BarState {
  /** Whether the bar is showing. Closing never changes `view`. */
  open: boolean;
  /** The text box. Kept across failures (FR-026). */
  text: string;
  /** e.g. "Shortened to 300 characters." */
  note: string | null;
  view: BarView;
  /** The change that can be undone now (kept on the server; mirrored here). */
  undo: UndoState | null;
}

export const initialBarState: BarState = { open: false, text: "", note: null, view: { kind: "idle" }, undo: null };

export type BarEvent =
  | { type: "open" }
  | { type: "close" }
  | { type: "toggle" }
  | { type: "type"; text: string }
  /** Enter. `text` is the raw box value; the reducer clips it. */
  | { type: "submit"; text: string }
  | { type: "reply"; reply: CommandReply }
  | { type: "applied"; result: CommandApplyResult; action: CommandAction }
  | { type: "failed"; message: string }
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "choose"; choice: CommandChoice }
  | { type: "undo-loaded"; undo: UndoState | null }
  | { type: "agent"; agent: Extract<BarView, { kind: "agent" }> }
  | { type: "duplicates"; plan: DuplicatePlan }
  | { type: "closing-duplicates" }
  | { type: "duplicates-done"; message: string };

/** The bar is busy: it accepts no new command until the current one ends. */
export const isBusy = (view: BarView): boolean =>
  view.kind === "interpreting" || view.kind === "running" || (view.kind === "agent" && view.phase === "running") || (view.kind === "duplicates" && view.closing);

export function barReducer(state: BarState, event: BarEvent): BarState {
  switch (event.type) {
    case "open":
      return { ...state, open: true };
    case "close":
      // Closing never cancels or clears: only `open` changes.
      return { ...state, open: false };
    case "toggle":
      return { ...state, open: !state.open };
    case "type":
      if (isBusy(state.view)) return state;
      // Typing after a result starts something new: the result goes away; Undo stays.
      return { ...state, text: event.text, note: null, view: state.view.kind === "idle" ? state.view : { kind: "idle" } };
    case "submit": {
      if (isBusy(state.view)) return state;
      const clipped = clipCommand(event.text);
      if (clipped.text === "") return state; // empty or whitespace: nothing happens, no request
      return { ...state, open: true, text: clipped.text, note: clipped.cut ? SHORTENED_NOTE : null, view: { kind: "interpreting" } };
    }
    case "reply": {
      const r = event.reply;
      switch (r.kind) {
        case "action":
          return { ...state, view: { kind: "running", understood: r.understood } };
        case "navigate":
          return { ...state, view: { kind: "done", message: r.understood, workspace: null } };
        case "found":
          return { ...state, view: { kind: "found", understood: r.understood, tabs: r.tabs, workspaces: r.workspaces, more: r.more, cutNote: r.cutNote } };
        case "recalled":
          return { ...state, view: { kind: "recalled", understood: r.understood, periodLabel: r.periodLabel, workspaces: r.workspaces } };
        case "say":
          return { ...state, view: { kind: "say", message: r.message, help: r.help } };
        case "ask":
          return { ...state, view: { kind: "ask", question: r.question, choices: r.choices } };
      }
      return state;
    }
    case "applied": {
      const result = event.result;
      switch (result.status) {
        case "needs_confirmation": {
          const understood = state.view.kind === "running" ? state.view.understood : "";
          return { ...state, view: { kind: "confirming", understood, action: event.action, preview: result.preview } };
        }
        case "done":
          return { ...state, undo: result.undo, view: { kind: "done", message: result.message, workspace: result.workspace } };
        case "nothing_to_do":
          return { ...state, undo: result.undo, view: { kind: "say", message: result.message, help: null } };
        case "refused":
          return { ...state, view: { kind: "failed", message: result.message } };
      }
      return state;
    }
    case "failed":
      // The typed text is kept; a failure is never shown as a result.
      return { ...state, view: { kind: "failed", message: event.message } };
    case "confirm":
      return state.view.kind === "confirming" ? { ...state, view: { kind: "running", understood: state.view.understood } } : state;
    case "cancel":
      return { ...state, view: { kind: "idle" } };
    case "choose": {
      const step = event.choice.step;
      if (isBusy(state.view)) return state;
      if (step.kind === "navigate") return { ...state, view: { kind: "done", message: event.choice.label, workspace: null } };
      if (step.kind === "submit") return { ...state, text: step.text.slice(0, COMMAND_MAX_CHARS), note: null, view: { kind: "idle" } };
      return { ...state, view: { kind: "running", understood: event.choice.label } };
    }
    case "undo-loaded":
      return { ...state, undo: event.undo };
    case "agent":
      return { ...state, view: event.agent };
    case "duplicates":
      return { ...state, view: event.plan.totalToClose > 0 ? { kind: "duplicates", plan: event.plan, closing: false } : { kind: "say", message: "No duplicate tabs found.", help: null } };
    case "closing-duplicates":
      return state.view.kind === "duplicates" ? { ...state, view: { ...state.view, closing: true } } : state;
    case "duplicates-done":
      return { ...state, view: { kind: "done", message: event.message, workspace: null } };
  }
  return state;
}

// ---------------------------------------------------------------------------------------------------
// An agent started from the bar (spec FR-017): the SAME route and client function the Home card uses
// (`pressAgent`), then the card's own poll (`readAgents` every POLL_MS) until that run is no longer running.
// The run is stored by the server either way, so reloading Home shows the same result on the card.
// ---------------------------------------------------------------------------------------------------

export type AgentView = Extract<BarView, { kind: "agent" }>;

export interface AgentFlowOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Tests only. */
  now?: () => number;
  /** Tests only. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Presses the agent and waits for its run. Never throws and never presses twice. `started` says whether a run
 * was stored (so the caller knows there is something new for a Home card to show).
 */
export async function runAgentFromBar(
  config: Config | null,
  action: Extract<CommandAction, { type: "agent" }>,
  understood: string,
  options: AgentFlowOptions = {},
): Promise<{ view: AgentView; started: boolean }> {
  const base = { kind: "agent" as const, understood, workspaceId: action.workspaceId };
  const stop = (message: string, started: boolean, phase: AgentView["phase"] = "failed") => ({ view: { ...base, phase, lines: [], message } as AgentView, started });
  if (!config) return stop(UNPAIRED_MESSAGE, false);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const requestOptions = { fetchImpl: options.fetchImpl, signal: options.signal };

  const pressed = await pressAgent(config, action.workspaceId, action.agentId, requestOptions);
  if (pressed.kind === "unreachable") return stop(UNREACHABLE_MESSAGE, false);
  if (pressed.kind === "already_running") return stop(ALREADY_RUNNING_MESSAGE, false);
  if (pressed.kind === "refused") return stop(pressed.message, false); // the card's own sentence, no AI request was made

  const runId = pressed.run.id;
  const began = now();
  while (now() - began < AGENT_WAIT_MS) {
    await sleep(POLL_MS);
    const read = await readAgents(config, action.workspaceId, requestOptions);
    if (!read) return stop(LOST_TOUCH_MESSAGE, true, "still");
    const entry = read.agents.find((candidate) => candidate.id === action.agentId);
    if (entry?.latest?.id === runId && entry.latest.output) {
      return { view: { ...base, phase: "result", lines: resultText(entry.latest.output.result).slice(0, AGENT_RESULT_LINES), message: null }, started: true };
    }
    if (entry?.lastFailed?.id === runId) return stop(describeRunOutcome(entry.lastFailed), true);
    if (!entry || entry.running === null) return stop(STILL_RUNNING_MESSAGE, true, "still"); // neither running nor ended as ours: do not guess
  }
  return stop(STILL_RUNNING_MESSAGE, true, "still");
}

// ---------------------------------------------------------------------------------------------------
// The controller: the bar's state and every flow, at MODULE level (one per page), so that closing or
// re-mounting the component never cancels or loses a command that is running or finished (FR-003,
// User Story 6 scenario 7). It uses only the client above and the host object; no React, no `chrome.*`.
// ---------------------------------------------------------------------------------------------------

export interface ControllerDeps {
  config: Config | null;
  host: CommandHost;
  /** Tests only. */
  fetchImpl?: typeof fetch;
}

export interface CommandController {
  getState(): BarState;
  subscribe(listener: () => void): () => void;
  /** Replaces the config and host (they can change between renders); in-flight work is untouched. */
  setDeps(deps: ControllerDeps): void;
  open(): void;
  close(): void;
  toggle(): void;
  type(text: string): void;
  /** Enter. Makes exactly one interpretation request, and none when the text is empty. */
  submit(text: string): Promise<void>;
  confirm(): Promise<void>;
  cancel(): void;
  choose(choice: CommandChoice): Promise<void>;
  /** The Undo control: the same `apply { undo }` a typed "undo" ends in. */
  undo(): Promise<void>;
  /** Confirm on the duplicate list: closes only the extra copies the host re-checks. Not undoable. */
  closeDuplicates(): Promise<void>;
  /** Asks the server what can be undone (the bar calls this when it opens). */
  loadUndo(): Promise<void>;
}

export function createCommandController(initial: ControllerDeps): CommandController {
  let deps = initial;
  let state: BarState = initialBarState;
  const listeners = new Set<() => void>();

  const dispatch = (event: BarEvent) => {
    const next = barReducer(state, event);
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const options = () => ({ fetchImpl: deps.fetchImpl });

  /** After any change to tabs or workspaces: this surface reloads and the others are told (FR-025). */
  const announceChange = () => {
    try {
      deps.host.refresh();
    } catch {
      // A surface that cannot refresh still works; the person can reload.
    }
    void sendSignal({ kind: "changed" });
  };

  /** One action through /apply. `confirmed` is true only after the person pressed Confirm. */
  async function runApply(action: CommandAction, confirmed: boolean): Promise<void> {
    const result = await applyCommand(deps.config, action, confirmed, options());
    if (result.kind !== "ok") {
      dispatch({ type: "failed", message: failureMessage(result) });
      return;
    }
    dispatch({ type: "applied", action, result: result.value });
    if (result.value.status !== "done") return;
    announceChange();
    if (result.value.next === "scan_duplicates") await scanForDuplicates();
  }

  /** The duplicate scan is the extension's job: the server cannot see two tabs of one address. */
  async function scanForDuplicates(): Promise<void> {
    try {
      dispatch({ type: "duplicates", plan: await deps.host.scanDuplicates() });
    } catch {
      dispatch({ type: "failed", message: GENERIC_MESSAGE });
    }
  }

  /** An agent: pressed through the 010 route (not /apply), then the short result is shown. */
  async function runAgent(action: Extract<CommandAction, { type: "agent" }>, understood: string): Promise<void> {
    dispatch({ type: "agent", agent: { kind: "agent", understood, workspaceId: action.workspaceId, phase: "running", lines: [], message: null } });
    const { view, started } = await runAgentFromBar(deps.config, action, understood, { fetchImpl: deps.fetchImpl });
    dispatch({ type: "agent", agent: view });
    if (started) void sendSignal({ kind: "changed" }); // a run was stored: other pages may want to look again
  }

  async function runStep(action: CommandAction, understood: string): Promise<void> {
    if (action.type === "agent") await runAgent(action, understood);
    else await runApply(action, false);
  }

  const controller: CommandController = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDeps(next) {
      deps = next;
    },
    open: () => dispatch({ type: "open" }),
    close: () => dispatch({ type: "close" }),
    toggle() {
      const opening = !state.open;
      dispatch({ type: "toggle" });
      if (opening) void controller.loadUndo();
    },
    type: (text) => dispatch({ type: "type", text }),

    async submit(text) {
      const before = state;
      dispatch({ type: "submit", text });
      // Empty text, or a command already running: the reducer ignored it, so nothing is sent. (Checking the
      // view alone is not enough: a second press while "interpreting" also leaves it "interpreting".)
      if (state === before) return;
      const typed = state.text;
      let context: CommandContext;
      try {
        context = await deps.host.getContext();
      } catch {
        dispatch({ type: "failed", message: GENERIC_MESSAGE });
        return;
      }
      const result = await interpretCommand(deps.config, { text: typed, context }, options());
      if (result.kind !== "ok") {
        dispatch({ type: "failed", message: failureMessage(result) });
        return;
      }
      const reply = result.value;
      dispatch({ type: "reply", reply });
      if (reply.kind === "navigate") {
        try {
          await deps.host.showHome(reply.target);
        } catch {
          // Coming forward is a convenience; the message is already shown.
        }
      } else if (reply.kind === "action") {
        await runStep(reply.action, reply.understood);
      }
    },

    async confirm() {
      const view = state.view;
      if (view.kind !== "confirming") return;
      dispatch({ type: "confirm" });
      await runApply(view.action, true);
    },
    cancel: () => dispatch({ type: "cancel" }),

    async choose(choice) {
      if (isBusy(state.view)) return;
      dispatch({ type: "choose", choice });
      const step = choice.step;
      if (step.kind === "action") await runStep(step.action, step.action.type === "agent" ? `Running ${agentName(step.action.agentId)} for ${choice.label}.` : choice.label);
      else if (step.kind === "navigate") await deps.host.showHome(step.target).catch(() => undefined);
      else await controller.submit(step.text);
    },

    async undo() {
      if (isBusy(state.view)) return;
      dispatch({ type: "reply", reply: { kind: "action", understood: "Undoing your last change.", action: { type: "undo" } } });
      await runApply({ type: "undo" }, false);
    },

    async closeDuplicates() {
      const view = state.view;
      if (view.kind !== "duplicates" || view.closing) return; // a second click while closing is ignored
      dispatch({ type: "closing-duplicates" });
      try {
        const { closed, skipped } = await deps.host.closeDuplicates(view.plan);
        dispatch({ type: "duplicates-done", message: closedMessage(closed, skipped) });
        announceChange();
      } catch {
        dispatch({ type: "failed", message: GENERIC_MESSAGE });
      }
    },

    async loadUndo() {
      const result = await readUndo(deps.config, options());
      if (result.kind === "ok") dispatch({ type: "undo-loaded", undo: result.value });
    },
  };
  return controller;
}

let shared: CommandController | null = null;

/** The one controller of this page. Created on first use; later calls update its config and host. */
export function getCommandController(deps: ControllerDeps): CommandController {
  if (!shared) shared = createCommandController(deps);
  else shared.setDeps(deps);
  return shared;
}

/**
 * The visible control's action: toggles this page's bar. A page whose bar has not mounted yet has no
 * controller, and the press does nothing (the control is drawn by the same boundary that mounts the bar).
 */
export function toggleCommandBar(): void {
  shared?.toggle();
}

/** Tests only. */
export function resetCommandControllerForTests(): void {
  shared = null;
}
