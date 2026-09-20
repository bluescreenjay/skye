// How the pages of the extension tell each other about the command bar (feature 011,
// specs/011-global-command-bar/contracts/extension.md, "Signals"). Home, the Side Panel, and the service
// worker share `chrome.storage.session` (no new permission). One key holds the latest signal:
//   open      the shortcut was pressed for this tab: toggle the bar
//   changed   a command changed tabs or workspaces: Home and the sidebar reload
//   navigate  bring Home forward, with a card expanded
// A page acts on `storage.onChanged`, and on mount on a signal younger than SIGNAL_FRESH_MS (a panel that
// was just opened has not loaded yet when the request is written). Everything is best-effort: a storage
// error is swallowed and the bar still works. No `chrome.tabs`, so this file is safe outside `home/`.
import type { NavTarget } from "@ai-browser/shared";

export const SIGNAL_KEY = "command.signal";
/** A signal older than this is not acted on when a page mounts. */
export const SIGNAL_FRESH_MS = 3_000;

export type CommandSignal =
  | { kind: "open"; tabId: number | "new"; at: number }
  | { kind: "changed"; at: number }
  | { kind: "navigate"; target: NavTarget; at: number };

/** A signal before it is stamped. */
export type SignalInput =
  | { kind: "open"; tabId: number | "new" }
  | { kind: "changed" }
  | { kind: "navigate"; target: NavTarget };

let lastAt = 0;

/** Writes the signal, overwriting the last one. `at` only ever goes up, so two identical signals still change the value. */
export async function sendSignal(signal: SignalInput, now: number = Date.now()): Promise<void> {
  try {
    lastAt = Math.max(now, lastAt + 1);
    await chrome.storage.session.set({ [SIGNAL_KEY]: { ...signal, at: lastAt } satisfies CommandSignal });
  } catch {
    // Best-effort: the person can reload.
  }
}

function isSignal(value: unknown): value is CommandSignal {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.at === "number" && (v.kind === "open" || v.kind === "changed" || v.kind === "navigate");
}

/** Calls `handler` for every new signal. Returns the unsubscribe function. */
export function onSignal(handler: (signal: CommandSignal) => void): () => void {
  try {
    const listener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => {
      if (areaName !== "session") return;
      const next = changes[SIGNAL_KEY]?.newValue;
      if (isSignal(next)) handler(next);
    };
    chrome.storage.onChanged.addListener(listener as Parameters<typeof chrome.storage.onChanged.addListener>[0]);
    return () => {
      try {
        chrome.storage.onChanged.removeListener(listener as Parameters<typeof chrome.storage.onChanged.removeListener>[0]);
      } catch {
        // Already gone.
      }
    };
  } catch {
    return () => undefined;
  }
}

/** The stored signal if it is fresh and newer than the last one this page handled, else null. */
export async function takeFreshSignal(lastHandledAt: number, now: number = Date.now()): Promise<CommandSignal | null> {
  try {
    const stored = (await chrome.storage.session.get(SIGNAL_KEY))[SIGNAL_KEY];
    if (!isSignal(stored)) return null;
    if (stored.at <= lastHandledAt) return null;
    if (now - stored.at > SIGNAL_FRESH_MS) return null;
    return stored;
  } catch {
    return null;
  }
}
