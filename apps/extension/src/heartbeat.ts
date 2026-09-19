// The 30-second heartbeat and the start-of-session reset, kept out of
// background.ts so they can be tested. Chrome's minimum alarm period is 30 s.
import type { SyncStatus, Store } from "./store";

export interface HeartbeatDeps {
  store: Pick<Store, "prune" | "getState">;
  collector: { flushDue: () => Promise<number> };
  sender: { drainOnce: () => Promise<unknown> };
  applyStatus: (status: SyncStatus) => Promise<void>;
}

/**
 * One tick: age out backlog that is too old (which marks a gap and asks for a
 * fresh snapshot), flush any update that has waited long enough (including
 * after the worker was stopped and lost its timers), deliver, and show status.
 * The sender takes the full snapshot itself when one is needed.
 */
export function createHeartbeat(deps: HeartbeatDeps) {
  return async function heartbeat(): Promise<void> {
    await deps.store.prune();
    await deps.collector.flushDue();
    await deps.sender.drainOnce();
    await deps.applyStatus((await deps.store.getState()).status);
  };
}

/**
 * A reload or a browser start is a chance to try again: clear a stuck status
 * (for example after credentials were rejected and the extension was rebuilt
 * with new ones) and ask for a full snapshot so the backend is reconciled.
 */
export async function resetSyncState(store: Pick<Store, "updateState">): Promise<void> {
  await store.updateState({ status: "idle", attempt: 0, nextAttemptAt: null, needsFullSnapshot: true });
}
