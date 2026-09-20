// In-memory suggestion set plus the in-flight pass (research 5). Lost on restart, which only costs one new pass.
import type { SuggestionSet } from "@ai-browser/shared";

export interface CachedSet {
  suggestions: SuggestionSet;
  fingerprint: string;
  generatedAt: number;
  inflight: Promise<SuggestionSet> | null;
}

type Holder = typeof globalThis & { __aiBrowserSuggestCache?: Map<string, CachedSet> };

function cache(): Map<string, CachedSet> {
  const holder = globalThis as Holder;
  return (holder.__aiBrowserSuggestCache ??= new Map());
}

export function cacheKey(userId: string, workspaceId: string): string {
  return `${userId}:${workspaceId}`;
}

export function getCached(userId: string, workspaceId: string): CachedSet | undefined {
  return cache().get(cacheKey(userId, workspaceId));
}

export function setCached(userId: string, workspaceId: string, value: CachedSet): void {
  cache().set(cacheKey(userId, workspaceId), value);
}

export function resetSuggestCacheForTests(): void {
  delete (globalThis as Holder).__aiBrowserSuggestCache;
}

export function fingerprintOf(parts: {
  tabs: { id: string; title: string }[];
  summaryUpdatedAt: string | null;
  plan: { text: string; done: boolean }[];
  queries: string[];
  connected: string[];
  owner: boolean;
}): string {
  return JSON.stringify(parts);
}
