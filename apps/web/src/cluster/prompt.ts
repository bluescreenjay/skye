// Pure logic around the model call: what we send (contracts/model.md "What the
// server sends") and how we check what comes back ("Validation"). No database, no
// network, no logging, so it is easy to test and easy to reason about privacy.
import { ModelError } from "../llm/errors";
import { MIN_GROUP_SIZE, type ClusterModelInput } from "./model";

const TITLE_MAX = 200;
const URL_MAX = 200;
const SNIPPET_MAX = 600;
const NAME_MAX = 80;
const EMOJI_MAX_CHARS = 4; // a single emoji can be several code points (flags, skin tones)

export interface Candidate {
  id: string;
  url: string;
  title: string;
  snippet: string;
}

export interface WorkspaceRef {
  id: string;
  name: string;
}

/** A group after validation: real tab-ref ids, a usable name, a confidence in 0..1. */
export interface ValidatedGroup {
  name: string;
  emoji: string | null;
  confidence: number;
  existingWorkspaceId: string | null;
  tabRefIds: string[];
}

/** The address without its query string or fragment (they carry tokens and personal data), capped. */
export function stripUrl(url: string): string {
  let clean: string;
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    clean = parsed.toString();
  } catch {
    clean = url.split(/[?#]/)[0];
  }
  return clean.slice(0, URL_MAX);
}

/**
 * What we send: short ids (t1, t2, ...), capped title/url/snippet, and workspaces as
 * id + name. Nothing else: no user id, token, timestamp, or stored tab-ref id.
 * `idMap` maps each short id back to the candidate's real id.
 */
export function buildRequest(
  candidates: Candidate[],
  workspaces: WorkspaceRef[],
): { input: ClusterModelInput; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  const tabs = candidates.map((c, i) => {
    const id = `t${i + 1}`;
    idMap.set(id, c.id);
    return { id, title: c.title.slice(0, TITLE_MAX), url: stripUrl(c.url), snippet: c.snippet.slice(0, SNIPPET_MAX) };
  });
  return { input: { workspaces: workspaces.map((w) => ({ id: w.id, name: w.name })), tabs }, idMap };
}

// "Group 3", "Untitled", "Miscellaneous", "Tabs 2" ... names that say nothing about the tabs.
const GENERIC_NAME = /^(group|cluster|untitled|unnamed|miscellaneous|misc|other|tabs?|workspace)\s*[#\-:]?\s*\d*$/i;

export function usableName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (name.length < 1 || name.length > NAME_MAX) return null;
  if (GENERIC_NAME.test(name)) return null;
  return name;
}

function usableEmoji(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const emoji = value.trim();
  if (emoji.length === 0 || Array.from(emoji).length > EMOJI_MAX_CHARS) return null;
  return emoji;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Checks the model's answer. Only a wrong top-level shape throws (ModelError); a bad
 * group is discarded and counted, and its tabs stay where they were. A tab claimed by
 * two groups goes to the more confident one. Discarded groups claim nothing.
 */
export function validateAnswer(
  answer: unknown,
  idMap: Map<string, string>,
  workspaces: WorkspaceRef[],
): { groups: ValidatedGroup[]; discarded: number } {
  if (!isObject(answer) || !Array.isArray(answer.groups)) {
    throw new ModelError("The AI service returned an answer in an unexpected shape.");
  }
  const knownWorkspaces = new Set(workspaces.map((w) => w.id));
  let discarded = 0;

  // Pass 1: each group on its own.
  const candidates: (ValidatedGroup & { shortIds: string[] })[] = [];
  for (const raw of answer.groups) {
    if (!isObject(raw)) {
      discarded += 1;
      continue;
    }
    const name = usableName(raw.name);
    const confidence = raw.confidence;
    if (name === null || typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      discarded += 1;
      continue;
    }
    const seen = new Set<string>();
    const shortIds: string[] = [];
    for (const id of Array.isArray(raw.tabIds) ? raw.tabIds : []) {
      if (typeof id === "string" && idMap.has(id) && !seen.has(id)) {
        seen.add(id);
        shortIds.push(id);
      }
    }
    candidates.push({
      name,
      emoji: usableEmoji(raw.emoji),
      confidence,
      existingWorkspaceId:
        typeof raw.existingWorkspaceId === "string" && knownWorkspaces.has(raw.existingWorkspaceId) ? raw.existingWorkspaceId : null,
      tabRefIds: [],
      shortIds,
    });
  }

  // Pass 2: most confident first, so a contested tab goes to the more confident group.
  const claimed = new Set<string>();
  const groups: ValidatedGroup[] = [];
  for (const c of [...candidates].sort((a, b) => b.confidence - a.confidence)) {
    const free = c.shortIds.filter((id) => !claimed.has(id));
    if (free.length < MIN_GROUP_SIZE) {
      discarded += 1;
      continue;
    }
    for (const id of free) claimed.add(id);
    const { shortIds: _shortIds, ...group } = c;
    groups.push({ ...group, tabRefIds: free.map((id) => idMap.get(id)!) });
  }
  return { groups, discarded };
}
