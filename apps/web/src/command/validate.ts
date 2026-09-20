// Checks the interpreter's answer (specs/011-global-command-bar/contracts/model.md, "Validation").
// Pure: no database, no network, no logging. Only a wrong top-level shape throws (ModelError);
// everything else is repaired or dropped, so a bad field can only ever make the answer a question.
import type { AgentId } from "@ai-browser/shared";
import { getAgent } from "../agents/catalog";
import { usableName } from "../cluster/prompt";
import { ModelError } from "../llm/errors";
import { MAX_ALTERNATIVES, MAX_DESCRIBED_TABS, MAX_PARTS, MAX_WORKSPACE_MATCHES, MODEL_FOUND_TABS, PART_MAX_CHARS } from "./limits";
import { ALTERNATIVE_KEYS, INTENT_ENUM, PERIOD_KINDS, WEEKDAYS, type InterpretedIntent } from "./schema";

export interface InterpretedPeriod {
  kind: (typeof PERIOD_KINDS)[number];
  date: string | null;
  weekday: (typeof WEEKDAYS)[number] | null;
}

/** The validated answer. Ids are REAL ids (short ids already mapped); unknown ones are gone. */
export interface Interpretation {
  intent: InterpretedIntent;
  confidence: number;
  agent: AgentId | null;
  subject: string[];
  subjectNamed: boolean;
  destination: string[];
  destinationNamed: boolean;
  toOther: boolean;
  thisWorkspace: boolean;
  scope: "none" | "these_tabs" | "this_tab";
  tabs: string[];
  workspaces: string[];
  name: string | null;
  period: InterpretedPeriod | null;
  reason: "not_supported" | "page_content" | null;
  alternatives: (typeof ALTERNATIVE_KEYS)[number][];
  parts: string[];
}

export interface ValidateContext {
  /** The command exactly as typed. */
  text: string;
  tabIdMap: Map<string, string>;
  workspaceIdMap: Map<string, string>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Short ids -> real ids: only ids we sent, no duplicates, order kept, at most `max`. */
function mapIds(value: unknown, map: Map<string, string>, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const real = map.get(item.trim());
    if (real !== undefined && !out.includes(real)) out.push(real);
    if (out.length >= max) break;
  }
  return out;
}

function realDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value) ? value : null;
}

function validPeriod(value: unknown): InterpretedPeriod | null {
  if (!isObject(value)) return null;
  const kind = (PERIOD_KINDS as readonly unknown[]).includes(value.kind) ? (value.kind as InterpretedPeriod["kind"]) : null;
  if (kind === null) return null;
  const weekday = (WEEKDAYS as readonly unknown[]).includes(value.weekday) ? (value.weekday as InterpretedPeriod["weekday"]) : null;
  const date = realDate(value.date);
  if (kind === "date" && date === null) return null;
  if (kind === "weekday" && weekday === null) return null;
  return { kind, date, weekday };
}

export function validateAnswer(answer: unknown, ctx: ValidateContext): Interpretation {
  if (!isObject(answer) || typeof answer.intent !== "string") {
    throw new ModelError("The AI service returned an answer in an unexpected shape.");
  }
  const intent = (INTENT_ENUM as readonly string[]).includes(answer.intent) ? (answer.intent as InterpretedIntent) : "unsupported";
  const confidence =
    typeof answer.confidence === "number" && Number.isFinite(answer.confidence) && answer.confidence >= 0 && answer.confidence <= 1 ? answer.confidence : 0;

  const agent = typeof answer.agent === "string" && getAgent(answer.agent) ? (answer.agent as AgentId) : null;

  const lowered = ctx.text.toLowerCase();
  const parts: string[] = [];
  if (Array.isArray(answer.parts)) {
    for (const raw of answer.parts) {
      if (typeof raw !== "string") continue;
      const part = raw.trim();
      if (part.length < 1 || part.length > PART_MAX_CHARS) continue;
      if (!lowered.includes(part.toLowerCase())) continue; // verbatim pieces of what was typed, or nothing
      if (!parts.includes(part)) parts.push(part);
      if (parts.length >= MAX_PARTS) break;
    }
  }

  const alternatives: Interpretation["alternatives"] = [];
  if (Array.isArray(answer.alternatives)) {
    for (const raw of answer.alternatives) {
      if ((ALTERNATIVE_KEYS as readonly unknown[]).includes(raw) && !alternatives.includes(raw as never)) alternatives.push(raw as never);
      if (alternatives.length >= MAX_ALTERNATIVES) break;
    }
  }

  return {
    intent,
    confidence,
    agent,
    subject: mapIds(answer.subject, ctx.workspaceIdMap, MAX_WORKSPACE_MATCHES),
    subjectNamed: answer.subjectNamed === true,
    destination: mapIds(answer.destination, ctx.workspaceIdMap, MAX_WORKSPACE_MATCHES),
    destinationNamed: answer.destinationNamed === true,
    toOther: answer.toOther === true,
    thisWorkspace: answer.thisWorkspace === true,
    scope: answer.scope === "these_tabs" || answer.scope === "this_tab" ? answer.scope : "none",
    tabs: mapIds(answer.tabs, ctx.tabIdMap, intent === "find" ? MODEL_FOUND_TABS : MAX_DESCRIBED_TABS),
    workspaces: mapIds(answer.workspaces, ctx.workspaceIdMap, MAX_WORKSPACE_MATCHES + 2),
    name: usableName(answer.name),
    period: validPeriod(answer.period),
    reason: answer.reason === "page_content" || answer.reason === "not_supported" ? answer.reason : null,
    alternatives,
    parts,
  };
}
