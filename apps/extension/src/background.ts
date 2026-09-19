// MV3 service worker: wiring only. All logic lives in the modules it imports.
//
// Chrome stops this worker after 30 s of inactivity and wakes it for an event,
// so every listener is registered synchronously at the top level and nothing
// durable is kept in memory (see store.ts).
import { createCollector } from "./collector";
import { createConfigLoader } from "./config";
import { createHeartbeat, resetSyncState } from "./heartbeat";
import { createDrainScheduler, createSender } from "./sender";
import { installSidePanelGate } from "./sidepanel-gate";
import { createSnapshotter } from "./snapshot";
import { applyStatus } from "./status";
import { createStore } from "./store";

const SYNC_ALARM = "sync";
const HEARTBEAT_MINUTES = 0.5; // Chrome's minimum alarm period is 30 s

const store = createStore();
const config = createConfigLoader();

const sender = createSender({
  store,
  getConfig: () => config.get(),
  takeFullSnapshot: () => snapshotter.takeFullSnapshot(),
  sampleActive: () => snapshotter.sampleActive(),
});
/** Delivers, then shows the resulting status on the badge. */
async function drainAndShow() {
  const outcome = await sender.drainOnce();
  await applyStatus((await store.getState()).status);
  return outcome;
}
// After anything is queued, deliver it within about a second instead of
// waiting for the heartbeat.
const scheduler = createDrainScheduler({ drain: drainAndShow });
const onQueued = () => scheduler.schedule();
const collector = createCollector({ store, onQueued });
const snapshotter = createSnapshotter({ store, onQueued });
const heartbeat = createHeartbeat({ store, collector, sender, applyStatus });

/** Runs a handler unless the extension is misconfigured; a failure never escapes the listener. */
function run(label: string, handler: () => Promise<unknown>): void {
  if (!config.get().ok) return; // config logs one warning; nothing is read, queued, or sent
  handler().catch((error) => console.warn(`[ai-browser] ${label} failed`, error));
}

chrome.tabs.onCreated.addListener((tab) => run("tabs.onCreated", () => collector.onTabCreated(tab)));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) =>
  run("tabs.onUpdated", () => collector.onTabUpdated(tabId, changeInfo, tab)),
);
chrome.tabs.onRemoved.addListener((tabId) => run("tabs.onRemoved", () => collector.onTabRemoved(tabId)));
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) =>
  run("tabs.onReplaced", () => collector.onTabReplaced(addedTabId, removedTabId)),
);
chrome.tabs.onActivated.addListener((info) => run("tabs.onActivated", () => collector.onTabActivated(info)));
chrome.windows.onFocusChanged.addListener((windowId) =>
  run("windows.onFocusChanged", () => collector.onWindowFocusChanged(windowId)),
);
// tabs.onAttached / onDetached are intentionally not handled: moving a tab to
// another window does not make it a different tab.

// Install, update, or reload: try again from a clean status and report the
// current tabs. This is also how a rebuild with fixed credentials recovers.
chrome.runtime.onInstalled.addListener(() =>
  run("runtime.onInstalled", async () => {
    await resetSyncState(store);
    scheduler.schedule();
  }),
);

// Browser start: tab ids from the last session are meaningless, so close them
// out first; the full snapshot then reports whatever the browser restored.
chrome.runtime.onStartup.addListener(() =>
  run("runtime.onStartup", async () => {
    await snapshotter.resetForBrowserStart();
    await resetSyncState(store);
    scheduler.schedule();
  }),
);

// Heartbeat: age out old backlog, flush any update that has waited long enough
// (also after the worker was stopped and its timers were lost), deliver, and
// show the status.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) run("heartbeat", heartbeat);
});

// A missing config is the one problem that stops everything before it starts.
if (!config.get().ok) void applyStatus("misconfigured");

// Alarms persist across worker restarts; create it only if it is missing.
async function ensureHeartbeat(): Promise<void> {
  if (!(await chrome.alarms.get(SYNC_ALARM))) {
    await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: HEARTBEAT_MINUTES });
  }
}
ensureHeartbeat().catch((error) => console.warn("[ai-browser] could not create the heartbeat alarm", error));

// Toolbar click opens Home in a new tab. Not gated on ingest config: an unpaired
// token still shows the same chrome with an empty directory.
chrome.action.onClicked.addListener(() => {
  chrome.tabs
    .create({ url: chrome.runtime.getURL("home.html") })
    .catch((error) => console.warn("[ai-browser] could not open Home", error));
});

// Close/disable the Side Panel on Home and other non-web tabs; keep it on pages.
installSidePanelGate();

