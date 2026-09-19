// One reply at a time per workspace (specs/008-workspace-ai-chat/research.md section 6). The lock is
// held from before the person's message is saved until the reply is saved or abandoned, so two
// sends can never interleave their messages. It lives in memory on `globalThis` (like the budget
// and the limiter) and expires after 120 s, so a handler that dies can never lock a workspace forever.
// It covers one server process, which is how this project runs.

/** Longer than the 90 s cap on how long a reply may take. */
export const LOCK_STALE_MS = 120_000;

type Entry = { since: number };
const KEY = "__aiBrowserChatLocks";
type Holder = typeof globalThis & { [KEY]?: Map<string, Entry> };

function locks(): Map<string, Entry> {
  const holder = globalThis as Holder;
  return (holder[KEY] ??= new Map());
}

const keyOf = (userId: string, workspaceId: string) => `${userId}:${workspaceId}`;

/**
 * Takes the lock and returns the function that gives it back (safe to call twice, and never
 * releases a lock that has since been taken by someone else), or null when a fresh lock is held.
 */
export function tryLock(userId: string, workspaceId: string, now: number = Date.now()): (() => void) | null {
  const map = locks();
  const key = keyOf(userId, workspaceId);
  const held = map.get(key);
  if (held && now - held.since < LOCK_STALE_MS) return null;

  const entry: Entry = { since: now };
  map.set(key, entry);
  return () => {
    if (map.get(key) === entry) map.delete(key);
  };
}

/** Whether a fresh lock is held: a reply is being written for this workspace right now. */
export function isLocked(userId: string, workspaceId: string, now: number = Date.now()): boolean {
  const held = locks().get(keyOf(userId, workspaceId));
  return held !== undefined && now - held.since < LOCK_STALE_MS;
}

/** Tests only. */
export function resetLocksForTests(): void {
  delete (globalThis as Holder)[KEY];
}
