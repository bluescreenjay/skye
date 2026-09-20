// The start of every command route: read and check the body. Nothing here logs, and nothing here
// touches the database or the AI service (a refused request costs neither).
import type { CommandContext } from "@ai-browser/shared";
import { badAction, badContext, badTimeZone, textEmpty, textTooLong } from "./errors";
import { isUuid } from "./context";
import { MAX_EXPANDED_IDS, MAX_TEXT_CHARS, MAX_WINDOW_TAB_IDS } from "./limits";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw badContext();
  }
  if (!isObject(body)) throw badContext();
  return body;
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Every field of the context is checked; nothing is silently dropped or trimmed. */
export function validateContext(raw: unknown): CommandContext {
  if (!isObject(raw)) throw badContext();
  if (raw.surface !== "home" && raw.surface !== "page") throw badContext();
  if (typeof raw.timeZone !== "string") throw badContext();
  if (!isValidTimeZone(raw.timeZone)) throw badTimeZone();
  const expanded = raw.expandedWorkspaceIds;
  if (!Array.isArray(expanded) || expanded.length > MAX_EXPANDED_IDS || !expanded.every(isUuid)) throw badContext();
  const windowTabIds = raw.windowTabIds;
  if (!Array.isArray(windowTabIds) || windowTabIds.length > MAX_WINDOW_TAB_IDS || !windowTabIds.every(isInt)) throw badContext();
  let activeTab: CommandContext["activeTab"] = null;
  if (raw.activeTab !== null && raw.activeTab !== undefined) {
    const tab = raw.activeTab;
    if (!isObject(tab) || !isInt(tab.chromeTabId) || typeof tab.url !== "string" || tab.url.length > 2048) throw badContext();
    activeTab = { chromeTabId: tab.chromeTabId, url: tab.url };
  }
  return { surface: raw.surface, timeZone: raw.timeZone, expandedWorkspaceIds: expanded as string[], activeTab, windowTabIds: windowTabIds as number[] };
}

/** The body of POST /api/command: the text (1 to 300 characters after trimming, never cut here) and the context. */
export async function parseRequest(request: Request): Promise<{ text: string; context: CommandContext }> {
  const body = await readBody(request);
  if (typeof body.text !== "string") throw textEmpty();
  const text = body.text.trim();
  if (text.length === 0) throw textEmpty();
  if (text.length > MAX_TEXT_CHARS) throw textTooLong();
  return { text, context: validateContext(body.context) };
}

/** The body of POST /api/command/apply. The action itself is parsed by apply.ts. */
export async function parseApplyBody(request: Request): Promise<{ action: unknown; confirmed: boolean }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw badAction();
  }
  if (!isObject(body)) throw badAction();
  if (body.confirmed !== undefined && typeof body.confirmed !== "boolean") throw badAction();
  return { action: body.action, confirmed: body.confirmed === true };
}
