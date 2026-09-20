// In-memory stand-ins for the chrome.* APIs the extension uses, so the pure
// modules can be tested without a browser. Install once per test with
// installChromeMock(); it replaces globalThis.chrome and returns a handle the
// test uses to arrange state and inspect calls.

export interface MockTab {
  id: number;
  windowId: number;
  url?: string;
  title?: string;
  active?: boolean;
  incognito?: boolean;
  discarded?: boolean;
  status?: "loading" | "complete";
  pinned?: boolean;
  index?: number;
}

export interface ChromeMock {
  /** Backing data for chrome.storage.local. */
  storage: Map<string, unknown>;
  /** How many times each storage.local method was called. */
  storageCalls: { get: number; set: number; remove: number };
  /** Open tabs, as chrome.tabs.query / get see them. */
  tabs: MockTab[];
  /** Window that currently has focus; -1 means none (WINDOW_ID_NONE). */
  focusedWindowId: number;
  /** Text executeScript returns per tab id. An Error rejects the call. */
  scriptResults: Map<number, string | Error>;
  /** Tab ids executeScript was called for, in order. */
  scriptCalls: number[];
  badge: { text: string; color: string | undefined };
  alarms: Map<string, { periodInMinutes?: number; delayInMinutes?: number }>;
  /** Backing data for chrome.storage.session (feature 011 signals). */
  session: Map<string, unknown>;
  /**
   * Every call to the APIs the command bar uses, in the order they were made, so a test can prove that
   * `sidePanel.open` ran BEFORE any awaited call (Chrome accepts a shortcut as the user gesture only then).
   */
  calls: string[];
  /** Arguments of chrome.sidePanel.open, in order. */
  sidePanelOpens: Array<{ tabId?: number; windowId?: number }>;
  /** When true, chrome.sidePanel.open rejects. */
  sidePanelRejects: boolean;
  /** Tab ids passed to chrome.tabs.remove, in order (each call is one entry). */
  removedTabs: number[][];
  /** Arguments of chrome.tabs.create. */
  createdTabs: Array<{ url?: string }>;
  /** Fires the registered chrome.commands.onCommand listeners; returns whatever they returned. */
  fireCommand(command: string, tab?: unknown): unknown[];
}

const clone = <T>(value: T): T => structuredClone(value);

export function installChromeMock(): ChromeMock {
  const mock: ChromeMock = {
    storage: new Map(),
    storageCalls: { get: 0, set: 0, remove: 0 },
    tabs: [],
    focusedWindowId: 1,
    scriptResults: new Map(),
    scriptCalls: [],
    badge: { text: "", color: undefined },
    alarms: new Map(),
    session: new Map(),
    calls: [],
    sidePanelOpens: [],
    sidePanelRejects: false,
    removedTabs: [],
    createdTabs: [],
    fireCommand: (command, tab) => commandListeners.map((listener) => listener(command, tab)),
  };

  type ChangeListener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void;
  const changeListeners: ChangeListener[] = [];
  const commandListeners: Array<(command: string, tab?: unknown) => unknown> = [];
  const notify = (areaName: string, key: string, oldValue: unknown, newValue: unknown) => {
    for (const listener of [...changeListeners]) listener({ [key]: { oldValue, newValue } }, areaName);
  };

  const storageLocal = {
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      mock.storageCalls.get++;
      const out: Record<string, unknown> = {};
      if (keys == null) {
        for (const [k, v] of mock.storage) out[k] = clone(v);
        return out;
      }
      if (typeof keys === "string") keys = [keys];
      if (Array.isArray(keys)) {
        for (const k of keys) if (mock.storage.has(k)) out[k] = clone(mock.storage.get(k));
        return out;
      }
      for (const [k, dflt] of Object.entries(keys)) {
        out[k] = mock.storage.has(k) ? clone(mock.storage.get(k)) : dflt;
      }
      return out;
    },
    async set(items: Record<string, unknown>) {
      mock.storageCalls.set++;
      for (const [k, v] of Object.entries(items)) mock.storage.set(k, clone(v));
    },
    async remove(keys: string | string[]) {
      mock.storageCalls.remove++;
      for (const k of typeof keys === "string" ? [keys] : keys) mock.storage.delete(k);
    },
  };

  const storageSession = {
    async get(keys?: string | string[] | null) {
      mock.calls.push("storage.session.get");
      const out: Record<string, unknown> = {};
      const list = keys == null ? [...mock.session.keys()] : typeof keys === "string" ? [keys] : keys;
      for (const k of list) if (mock.session.has(k)) out[k] = clone(mock.session.get(k));
      return out;
    },
    async set(items: Record<string, unknown>) {
      mock.calls.push("storage.session.set");
      for (const [k, v] of Object.entries(items)) {
        const old = mock.session.get(k);
        mock.session.set(k, clone(v));
        notify("session", k, old, clone(v));
      }
    },
    async remove(keys: string | string[]) {
      mock.calls.push("storage.session.remove");
      for (const k of typeof keys === "string" ? [keys] : keys) {
        const old = mock.session.get(k);
        mock.session.delete(k);
        notify("session", k, old, undefined);
      }
    },
  };

  const asTab = (t: MockTab) => ({
    active: false,
    incognito: false,
    discarded: false,
    status: "complete",
    index: 0,
    ...t,
  });

  const tabs = {
    async query(info: { active?: boolean; windowId?: number; lastFocusedWindow?: boolean } = {}) {
      mock.calls.push("tabs.query");
      return mock.tabs
        .filter((t) => info.active === undefined || Boolean(t.active) === info.active)
        .filter((t) => info.windowId === undefined || t.windowId === info.windowId)
        .filter((t) => !info.lastFocusedWindow || t.windowId === mock.focusedWindowId)
        .map(asTab);
    },
    async get(id: number) {
      mock.calls.push("tabs.get");
      const tab = mock.tabs.find((t) => t.id === id);
      if (!tab) throw new Error(`No tab with id: ${id}.`);
      return asTab(tab);
    },
    async remove(ids: number | number[]) {
      mock.calls.push("tabs.remove");
      const list = typeof ids === "number" ? [ids] : ids;
      mock.removedTabs.push(list);
      mock.tabs = mock.tabs.filter((t) => !list.includes(t.id));
    },
    async create(props: { url?: string }) {
      mock.calls.push("tabs.create");
      mock.createdTabs.push(props);
      return { id: 9000 + mock.createdTabs.length, windowId: 1, ...props };
    },
  };

  const sidePanel = {
    open(options: { tabId?: number; windowId?: number }) {
      mock.calls.push("sidePanel.open");
      mock.sidePanelOpens.push(options);
      return mock.sidePanelRejects ? Promise.reject(new Error("sidePanel.open() may only be called in response to a user gesture.")) : Promise.resolve();
    },
  };

  const commands = {
    onCommand: {
      addListener(listener: (command: string, tab?: unknown) => unknown) {
        commandListeners.push(listener);
      },
      removeListener(listener: (command: string, tab?: unknown) => unknown) {
        const i = commandListeners.indexOf(listener);
        if (i >= 0) commandListeners.splice(i, 1);
      },
    },
  };

  const windows = {
    WINDOW_ID_NONE: -1,
    async getLastFocused() {
      const id = mock.focusedWindowId;
      return {
        id,
        focused: id !== -1,
        incognito: mock.tabs.some((t) => t.windowId === id && t.incognito === true),
      };
    },
  };

  const scripting = {
    async executeScript(injection: { target: { tabId: number } }) {
      const tabId = injection.target.tabId;
      mock.scriptCalls.push(tabId);
      const result = mock.scriptResults.get(tabId);
      if (result instanceof Error) throw result;
      return [{ result }];
    },
  };

  const action = {
    async setBadgeText(details: { text: string }) {
      mock.badge.text = details.text;
    },
    async setBadgeBackgroundColor(details: { color: string }) {
      mock.badge.color = details.color;
    },
  };

  const alarms = {
    async create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }) {
      mock.alarms.set(name, info);
    },
    async get(name: string) {
      const info = mock.alarms.get(name);
      return info ? { name, ...info } : undefined;
    },
    async clear(name: string) {
      return mock.alarms.delete(name);
    },
  };

  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: storageLocal,
      session: storageSession,
      onChanged: {
        addListener: (listener: ChangeListener) => changeListeners.push(listener),
        removeListener: (listener: ChangeListener) => {
          const i = changeListeners.indexOf(listener);
          if (i >= 0) changeListeners.splice(i, 1);
        },
      },
    },
    sidePanel,
    commands,
    runtime: { id: "test-extension-id", getURL: (path: string) => `chrome-extension://test-extension-id/${path}` },
    tabs,
    windows,
    scripting,
    action,
    alarms,
  };

  return mock;
}
