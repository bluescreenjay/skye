import { Component, useEffect, useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import type { NavTarget } from "@ai-browser/shared";
import type { Config } from "../config";
import { describeUndo, EXAMPLES, getCommandController, isBusy, toggleCommandBar, type BarState, type BarView, type CommandController, type CommandHost } from "./command";
import { onSignal, takeFreshSignal, type CommandSignal } from "./command-signal";
import "./command.css";

// The shared command bar (feature 011: specs/011-global-command-bar/contracts/extension.md). One component
// for Home and the Side Panel; it imports nothing Home-specific or sidebar-specific and never changes a tab.
// Everything it needs from the browser comes in through `host`. Every string from a reply is drawn as a text
// node: never HTML, markdown, links, or images. It keeps no history of commands (FR-030).

export interface UseCommandBarOptions {
  host: CommandHost;
  config: Config | null;
  /** Should THIS page open the bar for an `open` signal? (Home: its own tab id, or "new"; the panel: the active tab of its window.) */
  acceptsOpen: (tabId: number | "new") => boolean | Promise<boolean>;
  /** A command changed tabs or workspaces somewhere: reload what this page shows. */
  onChanged?: () => void;
  /** Bring a workspace card forward (Home). */
  onNavigate?: (target: NavTarget) => void;
}

export interface CommandBarHandle {
  controller: CommandController;
  state: BarState;
  host: CommandHost;
}

/** The signal this page last acted on, across mounts (React StrictMode mounts twice; a signal must act once). */
let lastHandledSignalAt = 0;

/**
 * The bar's state (owned by a module-level controller, so closing or re-mounting never cancels or clears a
 * command), the Ctrl/Cmd+K key, and the signals from the shortcut, other pages, and other commands.
 */
export function useCommandBar(options: UseCommandBarOptions): CommandBarHandle {
  const controller = getCommandController({ config: options.config, host: options.host });
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    // For when Chrome did not assign the command: the same toggle, from the keyboard, while this page has focus.
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        controller.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [controller]);

  useEffect(() => {
    let cancelled = false;
    const handle = async (signal: CommandSignal) => {
      if (cancelled || signal.at <= lastHandledSignalAt) return;
      lastHandledSignalAt = signal.at;
      try {
        if (signal.kind === "open") {
          if (await latest.current.acceptsOpen(signal.tabId)) if (!cancelled) controller.toggle();
        } else if (signal.kind === "changed") latest.current.onChanged?.();
        else latest.current.onNavigate?.(signal.target);
      } catch {
        // A signal that cannot be handled is dropped; the bar still works.
      }
    };
    const stop = onSignal((signal) => void handle(signal));
    // A panel that was just opened has not loaded when the request is written: take a fresh one on mount.
    void takeFreshSignal(lastHandledSignalAt).then((signal) => {
      if (signal) void handle(signal);
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [controller]);

  return { controller, state, host: options.host };
}

/** The visible control (always works, even when the shortcut could not be assigned). */
export function CommandBarButton({ className }: { className?: string }) {
  return (
    <button type="button" className={className ?? "cmd-open"} aria-keyshortcuts="Control+K Meta+K" onClick={() => toggleCommandBar()}>
      ⌘K
    </button>
  );
}

/** If the bar throws, it disappears and the page around it keeps working (FR-024, SC-013). */
export class CommandBarBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(): void {
    console.warn("[ai-browser] the command bar failed");
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function Body({ bar }: { bar: CommandBarHandle }) {
  const { controller, state, host } = bar;
  const view: BarView = state.view;
  const fill = (text: string) => controller.type(text);

  switch (view.kind) {
    case "idle":
      return (
        <div className="cmd-list" aria-label="examples">
          {EXAMPLES.map((example) => (
            <button key={example} type="button" className="cmd-ex" onClick={() => fill(example)}>
              {example}
            </button>
          ))}
        </div>
      );
    case "interpreting":
      return (
        <p className="cmd-status" role="status">
          working out what you mean…
        </p>
      );
    case "running":
      return (
        <>
          <p className="cmd-understood">{view.understood}</p>
          <p className="cmd-status" role="status">
            working…
          </p>
        </>
      );
    case "confirming":
      return (
        <>
          {view.understood ? <p className="cmd-understood">{view.understood}</p> : null}
          <ul className="cmd-preview" aria-label="what will change">
            <li>
              <p className="cmd-preview-title">{view.preview.title}</p>
            </li>
            {view.preview.lines.map((line, i) => (
              <li key={`${line.tabRefId ?? "line"}-${i}`}>
                <span>{line.title}</span>
                <span className="cmd-move">
                  {line.from} → {line.to}
                </span>
              </li>
            ))}
            {view.preview.hiddenCount > 0 ? <li className="cmd-move">and {view.preview.hiddenCount} more</li> : null}
          </ul>
          {view.action.type === "merge" ? <p className="cmd-hint">Nothing is deleted. The old workspace stays, with its chat and results, just with no tabs.</p> : null}
          <div className="cmd-actions">
            <button type="button" className="cmd-primary" onClick={() => void controller.confirm()}>
              confirm
            </button>
            <button type="button" className="cmd-secondary" onClick={() => controller.cancel()}>
              cancel
            </button>
          </div>
        </>
      );
    case "done":
      return (
        <>
          <p className="cmd-say" role="status">
            {view.message}
          </p>
          {view.workspace ? (
            <div className="cmd-actions">
              <button type="button" className="cmd-secondary" onClick={() => void host.showHome({ kind: "workspace", workspaceId: view.workspace!.id }).catch(() => undefined)}>
                open workspace
              </button>
            </div>
          ) : null}
        </>
      );
    case "say":
      return (
        <>
          <p className="cmd-say" role="status">
            {view.message}
          </p>
          {view.help ? (
            <div className="cmd-list" aria-label="what I can do">
              {view.help.map((example) => (
                <button key={example} type="button" className="cmd-ex" onClick={() => fill(example)}>
                  {example}
                </button>
              ))}
            </div>
          ) : null}
        </>
      );
    case "ask":
      return (
        <>
          <p className="cmd-question">{view.question}</p>
          <div className="cmd-list">
            {view.choices.map((choice, i) => (
              <button key={`${choice.label}-${i}`} type="button" className="cmd-choice" onClick={() => void controller.choose(choice)}>
                {choice.label}
              </button>
            ))}
          </div>
        </>
      );
    case "failed":
      return (
        <>
          <p className="cmd-failed" role="alert">
            {view.message}
          </p>
          <div className="cmd-actions">
            <button type="button" className="cmd-secondary" disabled={state.text.trim() === ""} onClick={() => void controller.submit(state.text)}>
              try again
            </button>
          </div>
        </>
      );
    case "agent":
      return (
        <>
          <p className="cmd-understood">{view.understood}</p>
          {view.phase === "running" ? (
            <p className="cmd-status" role="status">
              running… this can take up to a minute
            </p>
          ) : null}
          {view.phase === "result" ? (
            <div className="cmd-result" aria-label="result">
              {view.lines.map((line, i) => (
                <p key={i} className="cmd-say">
                  {line}
                </p>
              ))}
            </div>
          ) : null}
          {view.message ? (
            <p className={view.phase === "failed" ? "cmd-failed" : "cmd-say"} role={view.phase === "failed" ? "alert" : "status"}>
              {view.message}
            </p>
          ) : null}
          {view.phase !== "running" ? (
            <div className="cmd-actions">
              <button type="button" className="cmd-secondary" onClick={() => void host.showHome({ kind: "workspace", workspaceId: view.workspaceId }).catch(() => undefined)}>
                open workspace
              </button>
            </div>
          ) : null}
        </>
      );
    case "duplicates":
      return (
        <>
          <p className="cmd-understood">
            Found {view.plan.totalToClose} duplicate {view.plan.totalToClose === 1 ? "tab" : "tabs"}. One copy of each stays.
          </p>
          <ul className="cmd-preview" aria-label="duplicate tabs">
            {view.plan.groups.map((group) => (
              <li key={group.url}>
                <span>{group.title}</span>
                <span className="cmd-move">
                  {group.close.length + 1} copies, keeping 1
                </span>
              </li>
            ))}
          </ul>
          <p className="cmd-hint">Closing tabs can't be undone.</p>
          <div className="cmd-actions">
            <button type="button" className="cmd-primary" disabled={view.closing} onClick={() => void controller.closeDuplicates()}>
              close {view.plan.totalToClose} extra {view.plan.totalToClose === 1 ? "tab" : "tabs"}
            </button>
            <button type="button" className="cmd-secondary" disabled={view.closing} onClick={() => controller.cancel()}>
              cancel
            </button>
          </div>
        </>
      );
    case "recalled":
      return (
        <>
          <p className="cmd-understood">{view.understood}</p>
          <ul className="cmd-preview" aria-label="what you worked on">
            {view.workspaces.map((workspace) => (
              <li key={workspace.workspaceId ?? "other"}>
                <p className="cmd-preview-title">
                  {workspace.name} · {workspace.visits} {workspace.visits === 1 ? "visit" : "visits"}
                </p>
                {workspace.tabs.map((tab, i) => (
                  <span key={`${tab.url}-${i}`} className="cmd-move">
                    {tab.title || tab.url} ({tab.visits})
                  </span>
                ))}
                {workspace.linkable && workspace.workspaceId ? (
                  <span className="cmd-actions">
                    <button type="button" className="cmd-secondary" onClick={() => void host.showHome({ kind: "workspace", workspaceId: workspace.workspaceId! }).catch(() => undefined)}>
                      open workspace
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      );
    case "found":
      return (
        <>
          <p className="cmd-understood">{view.understood}</p>
          {view.cutNote ? <p className="cmd-hint">{view.cutNote}</p> : null}
          {view.tabs.length > 0 ? (
            <ul className="cmd-preview" aria-label="matching tabs">
              {view.tabs.map((found) => (
                <li key={found.tab.id}>
                  {/* A tab is a button that opens the person's own tab (or its saved address): never a link, never loaded. */}
                  <button type="button" className="cmd-choice" title={found.tab.url} onClick={() => void host.openTab(found.tab).catch(() => undefined)}>
                    {found.tab.title || found.tab.url}
                  </button>
                  <span className="cmd-move">{found.workspaceName}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {view.more > 0 ? <p className="cmd-hint">and {view.more} more</p> : null}
          {view.workspaces.length > 0 ? (
            <div className="cmd-list" aria-label="matching workspaces">
              {view.workspaces.map((found) => (
                <button
                  key={found.workspace.id}
                  type="button"
                  className="cmd-choice"
                  onClick={() => void host.showHome({ kind: "workspace", workspaceId: found.workspace.id }).catch(() => undefined)}
                >
                  {found.workspace.name} ({found.tabCount})
                </button>
              ))}
            </div>
          ) : null}
        </>
      );
    default:
      return null;
  }
}

export interface CommandBarProps {
  bar: CommandBarHandle;
  /**
   * "overlay" (default, the Side Panel): a dialog over the page, drawn only while open.
   * "inline" (Home): the text box IS Home's URL bar, always drawn, and what the bar has to say drops down
   * under it while it is open. Same controller, same views, same rules.
   */
  variant?: "overlay" | "inline";
  /** Inline only: the class of the text box (Home gives it the URL bar's look). */
  inputClassName?: string;
}

const PLACEHOLDER = "say what you want done…";

/** The bar. Overlay: renders nothing while closed. Either way its state lives in the controller, so reopening shows where it was. */
export function CommandBar({ bar, variant = "overlay", inputClassName }: CommandBarProps) {
  const { controller, state } = bar;
  const input = useRef<HTMLInputElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const busy = isBusy(state.view);
  const inline = variant === "inline";

  // Focus the box whenever the bar opens, and again when a command ends, selecting what was typed so the
  // next words replace it. Inline, a bar that closes (Escape, the shortcut again) lets go of the focus.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    if (!state.open) {
      if (inline && document.activeElement === el) el.blur();
      return;
    }
    if (busy) return;
    el.focus();
    if (state.view.kind !== "idle") el.select();
  }, [state.open, state.view.kind, busy, inline]);

  // Inline: a click anywhere else closes the dropdown (the overlay does this with its backdrop).
  useEffect(() => {
    if (!inline || !state.open) return;
    const onDown = (event: MouseEvent) => {
      if (wrap.current && event.target instanceof Node && !wrap.current.contains(event.target)) controller.close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [inline, state.open, controller]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      controller.close();
    }
  };

  const box = (
    <input
      ref={input}
      className={inline ? inputClassName : "cmd-input"}
      type="text"
      value={state.text}
      placeholder={PLACEHOLDER}
      aria-label="command"
      autoComplete="off"
      spellCheck={false}
      disabled={busy}
      onFocus={inline ? () => !state.open && controller.open() : undefined}
      onBlur={
        inline
          ? (event) => {
              // Tabbing away closes it; moving to something inside the dropdown does not.
              const next = event.relatedTarget;
              if (next instanceof Node && wrap.current && !wrap.current.contains(next)) controller.close();
            }
          : undefined
      }
      onChange={(event) => controller.type(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          void controller.submit(state.text);
        }
      }}
    />
  );

  const results = (
    <>
      {state.note ? <p className="cmd-note">{state.note}</p> : null}
      <div className="cmd-body">
        <Body bar={bar} />
        {state.undo && !busy ? (
          <button type="button" className="cmd-undo" onClick={() => void controller.undo()}>
            {describeUndo(state.undo)}
          </button>
        ) : null}
      </div>
    </>
  );

  if (inline) {
    return (
      <div ref={wrap} className="cmd-inline" onKeyDown={onKeyDown}>
        {box}
        {state.open ? (
          <div className="cmd-drop" role="region" aria-label="command bar">
            {results}
          </div>
        ) : null}
      </div>
    );
  }

  if (!state.open) return null;

  return (
    <div className="cmd-backdrop" onMouseDown={(event) => event.target === event.currentTarget && controller.close()} onKeyDown={onKeyDown}>
      <div className="cmd" role="dialog" aria-label="command bar" aria-modal="true">
        <div className="cmd-row">{box}</div>
        {results}
      </div>
    </div>
  );
}
