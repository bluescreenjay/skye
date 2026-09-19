// Delivery: turns the store's backlog into batched POSTs
// (contract: specs/002-tab-ingestion-extension/contracts/ingest-api.md).
//
// Guarantees:
//  - events are sent strictly in queue order and deleted only after a 200;
//  - a snapshot is removed only if it did not change while its request was in flight;
//  - only one request is ever in flight;
//  - nothing is dropped silently: a transient failure keeps everything and backs
//    off, rejected credentials stop sending, and a request the server calls
//    invalid is split until the single offending item is isolated and counted.
import type { IngestActiveTab, IngestBatchRequest, IngestBatchResponse } from "@ai-browser/shared";
import type { Config, ConfigResult } from "./config";
import type { BacklogEvent, DirtyTab, Store } from "./store";

export const MAX_EVENTS_PER_BATCH = 100;
export const BACKOFF_BASE_MS = 2000;
export const BACKOFF_MAX_MS = 5 * 60 * 1000;
const JITTER = 0.2; // up to 20% either way
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 25_000; // Chrome ends a worker whose fetch takes longer than 30 s to answer

export type DrainOutcome =
  | { outcome: "sent"; accepted: number; duplicates: number }
  | { outcome: "empty" }
  | { outcome: "busy" }
  | { outcome: "misconfigured" }
  | { outcome: "auth_failed" }
  | { outcome: "waiting"; until: number }
  | { outcome: "failed"; status?: number; error?: string };

export interface SenderDeps {
  store: Store;
  getConfig: () => ConfigResult;
  fetchFn?: typeof fetch;
  now?: () => number;
  uuid?: () => string;
  /** 0..1; 0.5 means no jitter. Injectable so tests get exact delays. */
  random?: () => number;
  /** The focused window and its active reportable tab. Null ids when unknown. */
  sampleActive?: () => Promise<IngestActiveTab>;
  /** Re-reads every open tab into the store. Called before sending a full snapshot. */
  takeFullSnapshot?: () => Promise<void>;
  requestTimeoutMs?: number;
}

type PostResult =
  | { kind: "ok"; answer: Partial<IngestBatchResponse> }
  | { kind: "auth" }
  | { kind: "invalid" }
  | { kind: "transient"; status?: number; error?: string; retryAfterMs?: number };

interface Payload {
  events: BacklogEvent[];
  tabs: { tabId: number; entry: DirtyTab }[];
  full: boolean;
}

type Delivered =
  | { kind: "ok"; accepted: number; duplicates: number; fullDone: boolean }
  | { kind: "auth" }
  | { kind: "transient"; status?: number; error?: string; retryAfterMs?: number };

/** Retry-After as seconds or an HTTP date, in milliseconds from now; undefined if unreadable. */
function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - nowMs;
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(Math.max(0, Math.round(ms)), MAX_RETRY_AFTER_MS);
}

export function createSender(deps: SenderDeps) {
  const { store } = deps;
  const fetchFn = deps.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  const random = deps.random ?? Math.random;
  const timeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  let inFlight = false;

  async function post(config: Config, request: IngestBatchRequest): Promise<PostResult> {
    let response: Response;
    try {
      response = await fetchFn(`${config.apiBaseUrl}/api/ingest/tabs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.deviceToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { kind: "transient", error: error instanceof Error ? error.message : String(error) };
    }

    if (response.status === 200) {
      let answer: Partial<IngestBatchResponse> = {};
      try {
        answer = (await response.json()) as Partial<IngestBatchResponse>;
      } catch {
        // The body is informational; a 200 is what acknowledges the batch.
      }
      return { kind: "ok", answer };
    }
    if (response.status === 401 || response.status === 403) return { kind: "auth" };
    if (response.status === 400 || response.status === 422 || response.status === 413) return { kind: "invalid" };
    // Everything else, including 404 from a wrong address, is treated as a
    // problem to wait out: the data stays queued.
    return {
      kind: "transient",
      status: response.status,
      retryAfterMs: parseRetryAfter(response.headers.get("Retry-After"), now()),
    };
  }

  async function ack(payload: Payload) {
    const last = payload.events.at(-1);
    if (last) await store.ackEvents(last.seq);
    await store.ackDirtyMany(
      payload.tabs.filter((t) => t.entry.ready).map((t) => ({ tabId: t.tabId, lastChangeAt: t.entry.lastChangeAt })),
    );
  }

  async function countQuarantined(n: number) {
    const state = await store.getState();
    await store.updateState({ quarantinedInvalid: state.quarantinedInvalid + n });
  }

  /**
   * Sends a payload. If the server calls it invalid (or too large), splits it:
   * events are halved until one event is left; a lone event that is still
   * rejected is quarantined (removed and counted) so it cannot block the queue,
   * and snapshots that are rejected on their own are quarantined the same way.
   */
  async function deliver(payload: Payload, ctx: { config: Config; active: IngestActiveTab }): Promise<Delivered> {
    const request: IngestBatchRequest = {
      batchId: uuid(),
      sentAt: new Date(now()).toISOString(),
      fullSnapshot: payload.full,
      active: ctx.active,
      tabs: payload.tabs.map((t) => t.entry.snapshot),
      events: payload.events.map((e) => e.event),
    };
    const result = await post(ctx.config, request);

    if (result.kind === "ok") {
      await ack(payload);
      return {
        kind: "ok",
        accepted: result.answer.accepted ?? 0,
        duplicates: result.answer.duplicates ?? 0,
        fullDone: payload.full,
      };
    }
    if (result.kind === "auth" || result.kind === "transient") return result;

    // The server rejected this exact request.
    if (payload.events.length > 1) {
      const mid = Math.ceil(payload.events.length / 2);
      const first = await deliver({ events: payload.events.slice(0, mid), tabs: payload.tabs, full: payload.full }, ctx);
      if (first.kind !== "ok") return first;
      const second = await deliver({ events: payload.events.slice(mid), tabs: [], full: false }, ctx);
      if (second.kind !== "ok") return second;
      return {
        kind: "ok",
        accepted: first.accepted + second.accepted,
        duplicates: first.duplicates + second.duplicates,
        fullDone: first.fullDone,
      };
    }
    if (payload.events.length === 1 && payload.tabs.length > 0) {
      // One event with snapshots: find out which of the two the server dislikes.
      const eventOnly = await deliver({ events: payload.events, tabs: [], full: false }, ctx);
      if (eventOnly.kind !== "ok") return eventOnly;
      const tabsOnly = await deliver({ events: [], tabs: payload.tabs, full: payload.full }, ctx);
      if (tabsOnly.kind !== "ok") return tabsOnly;
      return {
        kind: "ok",
        accepted: eventOnly.accepted + tabsOnly.accepted,
        duplicates: eventOnly.duplicates + tabsOnly.duplicates,
        fullDone: tabsOnly.fullDone,
      };
    }
    if (payload.events.length === 1) {
      await store.ackEvents(payload.events[0].seq);
      await countQuarantined(1);
      return { kind: "ok", accepted: 0, duplicates: 0, fullDone: false };
    }
    // Only snapshots, and they are rejected: drop them (the next change or full
    // snapshot resends them) rather than retry forever. A full snapshot is
    // treated as done so a permanently rejected one cannot loop.
    await store.ackDirtyMany(
      payload.tabs.filter((t) => t.entry.ready).map((t) => ({ tabId: t.tabId, lastChangeAt: t.entry.lastChangeAt })),
    );
    await countQuarantined(Math.max(1, payload.tabs.length));
    return { kind: "ok", accepted: 0, duplicates: 0, fullDone: payload.full };
  }

  /** Exponential backoff from 2 s to 5 min, with up to 20% jitter either way. */
  function backoffMs(attempt: number): number {
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
    return Math.round(base * (1 + (random() - 0.5) * 2 * JITTER));
  }

  async function drainOnce(): Promise<DrainOutcome> {
    if (inFlight) return { outcome: "busy" };
    const config = deps.getConfig();
    if (!config.ok) return { outcome: "misconfigured" };

    inFlight = true;
    try {
      const state = await store.getState();
      // Rejected credentials stop all sending until something resets the status
      // (a reload or browser start); nothing is dropped meanwhile.
      if (state.status === "auth_failed") return { outcome: "auth_failed" };
      if (state.nextAttemptAt !== null && now() < state.nextAttemptAt) {
        return { outcome: "waiting", until: state.nextAttemptAt };
      }

      const fullSnapshot = state.needsFullSnapshot;
      if (fullSnapshot && deps.takeFullSnapshot) await deps.takeFullSnapshot();

      const batch = await store.readBatch(MAX_EVENTS_PER_BATCH);
      // A full snapshot must list every open tab, so it includes snapshots that
      // are still settling. A normal request carries only the ready ones.
      const tabs = fullSnapshot ? await store.listDirty() : batch.dirty;
      if (!fullSnapshot && batch.events.length === 0 && tabs.length === 0) return { outcome: "empty" };

      let active: IngestActiveTab = { windowId: null, chromeTabId: null };
      try {
        active = (await deps.sampleActive?.()) ?? active;
      } catch {
        // No window to sample (for example while the browser is closing): send without it.
      }

      const result = await deliver({ events: batch.events, tabs, full: fullSnapshot }, { config: config.config, active });

      if (result.kind === "ok") {
        await store.updateState({
          status: "ok",
          attempt: 0,
          nextAttemptAt: null,
          lastSuccessAt: new Date(now()).toISOString(),
          ...(fullSnapshot && result.fullDone ? { needsFullSnapshot: false } : {}),
        });
        return { outcome: "sent", accepted: result.accepted, duplicates: result.duplicates };
      }

      if (result.kind === "auth") {
        // A fresh snapshot will be needed once credentials work again.
        await store.updateState({ status: "auth_failed", needsFullSnapshot: true, nextAttemptAt: null });
        return { outcome: "auth_failed" };
      }

      const attempt = state.attempt + 1;
      const delay = result.retryAfterMs ?? backoffMs(attempt);
      await store.updateState({ status: "retrying", attempt, nextAttemptAt: now() + delay });
      return { outcome: "failed", status: result.status, error: result.error };
    } finally {
      inFlight = false;
    }
  }

  return { drainOnce };
}

export type Sender = ReturnType<typeof createSender>;

export interface DrainSchedulerOptions {
  drain: () => Promise<unknown>;
  delayMs?: number;
  onError?: (error: unknown) => void;
}

/**
 * Runs a drain about `delayMs` after the first queued change and coalesces any
 * changes that arrive meanwhile, so delivery follows a change within about a
 * second instead of waiting for the 30-second heartbeat.
 */
export function createDrainScheduler(options: DrainSchedulerOptions) {
  const delayMs = options.delayMs ?? 1000;
  const onError = options.onError ?? ((error: unknown) => console.warn("[ai-browser] drain failed", error));
  let pending: ReturnType<typeof setTimeout> | undefined;

  return {
    schedule() {
      if (pending !== undefined) return;
      pending = setTimeout(() => {
        pending = undefined;
        options.drain().catch(onError);
      }, delayMs);
    },
  };
}
