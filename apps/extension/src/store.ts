// Durable state in chrome.storage.local. The service worker can be stopped at
// any moment and loses all memory, so nothing that matters lives anywhere else
// (see specs/002-tab-ingestion-extension/data-model.md).
//
// Keys (all prefixed "v1:"):
//   ev:<seq>          one queued event; delivered strictly in seq order
//   meta              { head, tail } queue positions
//   dirty:<tabId>     the latest snapshot for a tab, pending (still settling) or ready to send
//   dirty:ids         index of dirty tab ids
//   mirror            last reported state of every tracked tab
//   snip:<tabId>      the last snippet read for a tab and the address it came from
//   state             sync state
//
// Every operation runs through one promise chain, so concurrent handlers never
// interleave their read-modify-write cycles.
import type { TabEventInput, TabSnapshotInput } from "@ai-browser/shared";

export const BACKLOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const BACKLOG_MAX_EVENTS = 20_000;
const PRUNE_CHUNK = 500;

const PREFIX = "v1:";
const META_KEY = `${PREFIX}meta`;
const DIRTY_IDS_KEY = `${PREFIX}dirty:ids`;
const MIRROR_KEY = `${PREFIX}mirror`;
const STATE_KEY = `${PREFIX}state`;
const evKey = (seq: number) => `${PREFIX}ev:${seq}`;
const dirtyKey = (tabId: number) => `${PREFIX}dirty:${tabId}`;
const snipKey = (tabId: number) => `${PREFIX}snip:${tabId}`;

export interface StorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface BacklogEvent {
  seq: number;
  event: TabEventInput;
  /** Epoch ms when it was queued; drives the age prune. */
  queuedAt: number;
}

export interface DirtyTab {
  snapshot: TabSnapshotInput;
  /** False while the tab is still settling; only ready snapshots are delivered. */
  ready: boolean;
  firstDirtyAt: number;
  lastChangeAt: number;
}

export interface MirrorEntry {
  url: string;
  title: string;
  windowId: number;
  /** ISO-8601; used as the time of a `closed` event for a tab we lost track of. */
  lastSeenAt: string;
}

export type SyncStatus = "idle" | "ok" | "retrying" | "auth_failed" | "misconfigured";

/** The last snippet read for a tab, so an unchanged address does not need another read. */
export interface SnippetCacheEntry {
  url: string;
  text: string;
}

export interface SyncState {
  status: SyncStatus;
  needsFullSnapshot: boolean;
  attempt: number;
  nextAttemptAt: number | null;
  lastSuccessAt: string | null;
  droppedForAge: number;
  quarantinedInvalid: number;
}

export interface StoreChange {
  /** Appended to the backlog in order. */
  events?: TabEventInput[];
  /** Upserts of the latest snapshot per tab. */
  dirty?: { tabId: number; snapshot: TabSnapshotInput; ready: boolean }[];
  /** Pending or ready snapshots to discard (for example a closed tab). */
  dropDirty?: number[];
  /** Set (or with null, delete) mirror entries by tab id. */
  mirror?: Record<number, MirrorEntry | null>;
  /** Set (or with null, delete) cached snippets by tab id. */
  snippets?: Record<number, SnippetCacheEntry | null>;
}

export interface BatchRead {
  events: BacklogEvent[];
  /** Ready snapshots only. */
  dirty: { tabId: number; entry: DirtyTab }[];
  /** Highest seq in `events`, or null when there are none. */
  throughSeq: number | null;
}

interface Meta {
  head: number;
  tail: number;
}

const DEFAULT_STATE: SyncState = {
  status: "idle",
  needsFullSnapshot: false,
  attempt: 0,
  nextAttemptAt: null,
  lastSuccessAt: null,
  droppedForAge: 0,
  quarantinedInvalid: 0,
};

export interface StoreOptions {
  storage?: StorageArea;
  now?: () => number;
  maxEvents?: number;
  maxAgeMs?: number;
}

export function createStore(options: StoreOptions = {}) {
  const storage = options.storage ?? (chrome.storage.local as unknown as StorageArea);
  const now = options.now ?? Date.now;
  const maxEvents = options.maxEvents ?? BACKLOG_MAX_EVENTS;
  const maxAgeMs = options.maxAgeMs ?? BACKLOG_MAX_AGE_MS;

  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  }

  const readMeta = (raw: unknown): Meta => {
    const meta = raw as Meta | undefined;
    return meta ? { head: meta.head, tail: meta.tail } : { head: 0, tail: 0 };
  };

  async function readState(): Promise<SyncState> {
    const got = await storage.get(STATE_KEY);
    return { ...DEFAULT_STATE, ...(got[STATE_KEY] as Partial<SyncState> | undefined) };
  }

  /** Applies several changes with a single storage.local.set (plus one remove for deletions). */
  function apply(change: StoreChange): Promise<void> {
    return serial(async () => {
      const events = change.events ?? [];
      const dirty = change.dirty ?? [];
      const drop = change.dropDirty ?? [];

      const keys = new Set<string>();
      if (events.length) keys.add(META_KEY);
      if (dirty.length || drop.length) keys.add(DIRTY_IDS_KEY);
      for (const d of dirty) keys.add(dirtyKey(d.tabId));
      if (change.mirror) keys.add(MIRROR_KEY);
      if (keys.size === 0 && !change.snippets) return;

      const got = await storage.get([...keys]);
      const set: Record<string, unknown> = {};
      const remove: string[] = [];
      const t = now();

      if (events.length) {
        const meta = readMeta(got[META_KEY]);
        for (const event of events) {
          set[evKey(meta.tail)] = { event, queuedAt: t };
          meta.tail += 1;
        }
        set[META_KEY] = meta;
      }

      if (dirty.length || drop.length) {
        let ids = (got[DIRTY_IDS_KEY] as number[] | undefined) ?? [];
        for (const { tabId, snapshot, ready } of dirty) {
          const existing = got[dirtyKey(tabId)] as DirtyTab | undefined;
          // A tab that is already settling keeps its original start, so the
          // maximum-delay cap counts from the first change. A ready snapshot
          // that changes again starts a new wait.
          const firstDirtyAt = existing && !existing.ready ? existing.firstDirtyAt : t;
          set[dirtyKey(tabId)] = { snapshot, ready, firstDirtyAt, lastChangeAt: t } satisfies DirtyTab;
          if (!ids.includes(tabId)) ids = [...ids, tabId];
        }
        for (const tabId of drop) {
          ids = ids.filter((id) => id !== tabId);
          remove.push(dirtyKey(tabId));
          delete set[dirtyKey(tabId)];
        }
        set[DIRTY_IDS_KEY] = ids;
      }

      if (change.mirror) {
        const mirror = { ...((got[MIRROR_KEY] as Record<string, MirrorEntry> | undefined) ?? {}) };
        for (const [id, entry] of Object.entries(change.mirror)) {
          if (entry === null) delete mirror[id];
          else mirror[id] = entry;
        }
        set[MIRROR_KEY] = mirror;
      }

      if (change.snippets) {
        for (const [id, entry] of Object.entries(change.snippets)) {
          if (entry === null) remove.push(snipKey(Number(id)));
          else set[snipKey(Number(id))] = entry;
        }
      }

      if (Object.keys(set).length) await storage.set(set);
      if (remove.length) await storage.remove(remove);
    });
  }

  /** Up to `max` events from the head, plus every ready snapshot. Nothing is removed. */
  function readBatch(max: number): Promise<BatchRead> {
    return serial(async () => {
      const head = await storage.get([META_KEY, DIRTY_IDS_KEY]);
      const meta = readMeta(head[META_KEY]);
      const ids = (head[DIRTY_IDS_KEY] as number[] | undefined) ?? [];
      const end = Math.min(meta.tail, meta.head + max);

      const keys: string[] = ids.map(dirtyKey);
      for (let seq = meta.head; seq < end; seq++) keys.push(evKey(seq));
      const rows = await storage.get(keys);

      const events: BacklogEvent[] = [];
      for (let seq = meta.head; seq < end; seq++) {
        const rec = rows[evKey(seq)] as { event: TabEventInput; queuedAt: number } | undefined;
        if (rec) events.push({ seq, event: rec.event, queuedAt: rec.queuedAt });
      }
      const dirty: BatchRead["dirty"] = [];
      for (const tabId of ids) {
        const entry = rows[dirtyKey(tabId)] as DirtyTab | undefined;
        if (entry?.ready) dirty.push({ tabId, entry });
      }
      return { events, dirty, throughSeq: end > meta.head ? end - 1 : null };
    });
  }

  /** Deletes events up to and including throughSeq; call only after the server acknowledged them. */
  function ackEvents(throughSeq: number): Promise<void> {
    return serial(async () => {
      const got = await storage.get(META_KEY);
      const meta = readMeta(got[META_KEY]);
      if (throughSeq < meta.head) return;
      const upTo = Math.min(throughSeq, meta.tail - 1);
      const keys: string[] = [];
      for (let seq = meta.head; seq <= upTo; seq++) keys.push(evKey(seq));
      meta.head = upTo + 1;
      await storage.set({ [META_KEY]: meta });
      if (keys.length) await storage.remove(keys);
    });
  }

  /**
   * Removes snapshots that were delivered, but only those unchanged since the
   * batch was built: a change made while the request was in flight is kept.
   * Returns how many were removed.
   */
  function ackDirtyMany(items: { tabId: number; lastChangeAt: number }[]): Promise<number> {
    return serial(async () => {
      if (items.length === 0) return 0;
      const got = await storage.get([DIRTY_IDS_KEY, ...items.map((i) => dirtyKey(i.tabId))]);
      let ids = (got[DIRTY_IDS_KEY] as number[] | undefined) ?? [];
      const remove: string[] = [];
      for (const { tabId, lastChangeAt } of items) {
        const entry = got[dirtyKey(tabId)] as DirtyTab | undefined;
        if (!entry || entry.lastChangeAt !== lastChangeAt) continue;
        remove.push(dirtyKey(tabId));
        ids = ids.filter((id) => id !== tabId);
      }
      if (remove.length === 0) return 0;
      await storage.set({ [DIRTY_IDS_KEY]: ids });
      await storage.remove(remove);
      return remove.length;
    });
  }

  async function ackDirty(tabId: number, lastChangeAt: number): Promise<boolean> {
    return (await ackDirtyMany([{ tabId, lastChangeAt }])) === 1;
  }

  function listDirty(): Promise<{ tabId: number; entry: DirtyTab }[]> {
    return serial(async () => {
      const head = await storage.get(DIRTY_IDS_KEY);
      const ids = (head[DIRTY_IDS_KEY] as number[] | undefined) ?? [];
      if (ids.length === 0) return [];
      const rows = await storage.get(ids.map(dirtyKey));
      const out: { tabId: number; entry: DirtyTab }[] = [];
      for (const tabId of ids) {
        const entry = rows[dirtyKey(tabId)] as DirtyTab | undefined;
        if (entry) out.push({ tabId, entry });
      }
      return out;
    });
  }

  function getMirror(): Promise<Map<number, MirrorEntry>> {
    return serial(async () => {
      const got = await storage.get(MIRROR_KEY);
      const raw = (got[MIRROR_KEY] as Record<string, MirrorEntry> | undefined) ?? {};
      return new Map(Object.entries(raw).map(([id, entry]) => [Number(id), entry]));
    });
  }

  function getSnippet(tabId: number): Promise<SnippetCacheEntry | undefined> {
    return serial(async () => (await storage.get(snipKey(tabId)))[snipKey(tabId)] as SnippetCacheEntry | undefined);
  }

  function getState(): Promise<SyncState> {
    return serial(readState);
  }

  function updateState(patch: Partial<SyncState>): Promise<SyncState> {
    return serial(async () => {
      const next = { ...(await readState()), ...patch };
      await storage.set({ [STATE_KEY]: next });
      return next;
    });
  }

  function size(): Promise<number> {
    return serial(async () => {
      const meta = readMeta((await storage.get(META_KEY))[META_KEY]);
      return meta.tail - meta.head;
    });
  }

  /**
   * Drops events older than the retention window, then any beyond the count
   * ceiling, oldest first. Any drop is a gap: it is counted and a fresh full
   * snapshot is requested. Returns how many events were dropped.
   */
  function prune(): Promise<number> {
    return serial(async () => {
      const cutoff = now() - maxAgeMs;
      let dropped = 0;

      for (;;) {
        const meta = readMeta((await storage.get(META_KEY))[META_KEY]);
        if (meta.tail - meta.head <= 0) break;

        const oldHead = meta.head;
        const chunkEnd = Math.min(meta.tail, oldHead + PRUNE_CHUNK);
        const keys: string[] = [];
        for (let seq = oldHead; seq < chunkEnd; seq++) keys.push(evKey(seq));
        const rows = await storage.get(keys);

        let n = 0;
        for (let seq = oldHead; seq < chunkEnd; seq++) {
          const rec = rows[evKey(seq)] as { queuedAt: number } | undefined;
          const tooMany = meta.tail - seq > maxEvents;
          if (!rec || rec.queuedAt < cutoff || tooMany) n++;
          else break;
        }
        if (n === 0) break;

        meta.head = oldHead + n;
        await storage.set({ [META_KEY]: meta });
        await storage.remove(keys.slice(0, n));
        dropped += n;
        if (n < chunkEnd - oldHead) break;
      }

      if (dropped > 0) {
        const state = await readState();
        await storage.set({
          [STATE_KEY]: {
            ...state,
            droppedForAge: state.droppedForAge + dropped,
            needsFullSnapshot: true,
          },
        });
      }
      return dropped;
    });
  }

  return {
    apply,
    readBatch,
    ackEvents,
    ackDirty,
    ackDirtyMany,
    listDirty,
    getMirror,
    getSnippet,
    getState,
    updateState,
    size,
    prune,
  };
}

export type Store = ReturnType<typeof createStore>;
