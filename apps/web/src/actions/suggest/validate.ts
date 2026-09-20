// Server-side validation of a suggestion pass (contracts/model.md §1). Failures are dropped,
// never repaired, never padded.
import type { ActionEffect, ActionSuggestion, SuggestionPreviewField } from "@ai-browser/shared";
import { expandPlaceholders, validateArgs } from "../args";
import { LABEL_CHARS, PREVIEW_VALUE_CHARS, REASON_CHARS, SUGGEST_KEEP } from "../limits";
import type { AccessFacts, ToolDef } from "../registry";
import { getTool } from "../registry";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function effectOf(tool: ToolDef): ActionEffect {
  if (tool.effect === "send" || tool.id.startsWith("gmail_")) return "email";
  if (tool.id === "open_related_tabs" || tool.id === "open_google_searches" || tool.id.startsWith("export_")) return "browser";
  if (tool.integration) return "external";
  return "local";
}

function previewOf(tool: ToolDef, args: Record<string, unknown>): SuggestionPreviewField[] {
  const fields: SuggestionPreviewField[] = [];
  for (const name of Object.keys(tool.inputSchema.properties)) {
    const value = args[name];
    if (value === undefined) continue;
    let text: string;
    if (typeof value === "boolean") text = value ? "yes" : "no";
    else if (Array.isArray(value)) text = value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(" · ");
    else if (typeof value === "string") text = value.length > 160 ? `${value.slice(0, 160)}… (${value.length} characters)` : value;
    else text = String(value);
    if (text.length > PREVIEW_VALUE_CHARS) text = `${text.slice(0, PREVIEW_VALUE_CHARS - 1)}…`;
    fields.push({ name: name.replace(/([A-Z])/g, " $1").replace(/_/g, " ").toLowerCase(), value: text });
  }
  return fields;
}

export function validateSuggestions(
  raw: unknown,
  allowed: ToolDef[],
  facts: AccessFacts,
  vars: { summary: string; workspace: string },
): { suggestions: ActionSuggestion[]; note: string | null } {
  const allowedIds = new Set(allowed.map((tool) => tool.id));
  const list = isPlainObject(raw) && Array.isArray(raw.suggestions) ? raw.suggestions : [];
  const kept: ActionSuggestion[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (kept.length >= SUGGEST_KEEP) break;
    if (!isPlainObject(item)) continue;
    const toolId = typeof item.tool === "string" ? item.tool : "";
    if (!allowedIds.has(toolId) || seen.has(toolId)) continue;
    const tool = getTool(toolId);
    if (!tool) continue;
    if (tool.preconditions(facts)) continue;
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(typeof item.argsJson === "string" ? item.argsJson : "{}") as unknown;
      if (!isPlainObject(parsed)) continue;
      args = expandPlaceholders(parsed, vars);
      args = validateArgs(tool, args, { requireVisible: Boolean(Object.values(tool.argFlags).some((f) => f.visible)) });
    } catch {
      continue;
    }
    const label = typeof item.label === "string" ? item.label.trim() : "";
    const reason = typeof item.reason === "string" ? item.reason.trim() : "";
    if (!label || !reason) continue;
    seen.add(toolId);
    kept.push({
      id: `s${kept.length + 1}`,
      toolId,
      label: label.slice(0, LABEL_CHARS),
      reason: reason.slice(0, REASON_CHARS),
      args,
      preview: previewOf(tool, args),
      effect: effectOf(tool),
      service: tool.integration,
    });
  }
  let note: string | null = null;
  if (kept.length > 0 && kept.length < 3) note = `Only ${kept.length} fitting action${kept.length === 1 ? "" : "s"} right now.`;
  return { suggestions: kept, note };
}
