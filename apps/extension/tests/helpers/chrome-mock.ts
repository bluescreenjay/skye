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
      return mock.tabs
        .filter((t) => info.active === undefined || Boolean(t.active) === info.active)
        .filter((t) => info.windowId === undefined || t.windowId === info.windowId)
        .filter((t) => !info.lastFocusedWindow || t.windowId === mock.focusedWindowId)
        .map(asTab);
    },
    async get(id: number) {
      const tab = mock.tabs.find((t) => t.id === id);
      if (!tab) throw new Error(`No tab with id: ${id}.`);
      return asTab(tab);
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
    storage: { local: storageLocal },
    tabs,
    windows,
    scripting,
    action,
    alarms,
  };

  return mock;
}
