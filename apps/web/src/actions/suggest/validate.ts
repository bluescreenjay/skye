// Server-side validation of a suggestion pass (contracts/model.md §1).
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
  // FR-050: what will be created is on the button before the click, including that nobody is invited.
  if (tool.id === "calendar_create_event") fields.push({ name: "guests", value: "none (no invitations are sent)" });
  return fields;
}

// Only creation actions enter the MCP suggestion slots. A click still runs the action.
const CREATE_TOOLS = new Set([
  "github_create_issue", "github_create_gist", "jira_create_issue", "notion_create_page",
  "slack_post_message", "slack_upload_snippet", "drive_upload_markdown",
  "drive_create_doc_from_summary", "gmail_create_draft", "calendar_create_event",
]);

const CREATE_FALLBACKS = [
  "notion_create_page", "drive_create_doc_from_summary", "github_create_gist",
  "slack_upload_snippet", "gmail_create_draft", "jira_create_issue", "calendar_create_event",
] as const;

function fallbackArgs(id: string, vars: { summary: string; workspace: string }): Record<string, unknown> {
  const name = vars.workspace.trim();
  const content = vars.summary.trim() || `Workspace notes: ${name}`;
  switch (id) {
    case "notion_create_page": return { title: name, content };
    case "drive_create_doc_from_summary": return { title: name };
    case "github_create_gist": return { filename: "workspace-notes.md", content: `# ${name}\n\n${content}`, description: name };
    case "slack_upload_snippet": return { filename: "workspace-notes.md", content: `# ${name}\n\n${content}`, title: name };
    case "gmail_create_draft": return { subject: name, body: content };
    case "jira_create_issue": return { summary: name, description: content };
    case "calendar_create_event": return {
      title: `${name} planning`,
      start: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString().slice(0, 10),
      notes: `Suggested planning day for ${name}.`,
    };
    default: return {};
  }
}

export function validateSuggestions(
  raw: unknown,
  allowed: ToolDef[],
  facts: AccessFacts,
  vars: { summary: string; workspace: string; workspaceId?: string },
): { suggestions: ActionSuggestion[]; note: string | null } {
  const allowedIds = new Set(allowed.map((tool) => tool.id));
  const list = isPlainObject(raw) && Array.isArray(raw.suggestions) ? raw.suggestions : [];
  const kept: ActionSuggestion[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!isPlainObject(item)) continue;
    const toolId = typeof item.tool === "string" ? item.tool : "";
    if (!allowedIds.has(toolId) || seen.has(toolId)) continue;
    const tool = getTool(toolId);
    if (!tool) continue;
    if (tool.integration && !CREATE_TOOLS.has(toolId)) continue;
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
  for (const id of CREATE_FALLBACKS) {
    const tool = allowed.find((candidate) => candidate.id === id);
    if (!tool || !tool.integration || seen.has(id)) continue;
    if (kept.some((item) => item.service === tool.integration)) continue;
    try {
      const valid = validateArgs(tool, fallbackArgs(id, vars));
      kept.push({
        id: "",
        toolId: id,
        label: tool.label,
        reason: id === "calendar_create_event"
          ? "Suggested all-day planning event tomorrow (UTC); check the date before running."
          : `Create this from the ${vars.workspace.slice(0, 60)} workspace.`,
        args: valid,
        preview: previewOf(tool, valid),
        effect: effectOf(tool),
        service: tool.integration,
      });
      seen.add(id);
    } catch {
      // An invalid title or overlong material cannot supply a valid creation preview.
    }
  }
  const services = kept.filter((item) => item.service !== null);
  const locals = kept.filter((item) => item.service === null);
  const byService = new Map<string, ActionSuggestion>();
  for (const item of services) if (item.service && !byService.has(item.service)) byService.set(item.service, item);
  const serviceIds = [...byService.keys()].sort();
  // A stable workspace ID changes which service leads. Every eligible service gets a slot when
  // there are six or fewer; with seven, the omitted service rotates across workspace IDs.
  const rotationKey = vars.workspaceId ?? vars.workspace;
  const offset = serviceIds.length ? [...rotationKey].reduce((sum, char) => sum + char.charCodeAt(0), 0) % serviceIds.length : 0;
  const rotatedIds = [...serviceIds.slice(offset), ...serviceIds.slice(0, offset)];
  const rotatedServices = rotatedIds.map((id) => byService.get(id)!);
  const ordered = [...rotatedServices, ...locals]
    .slice(0, SUGGEST_KEEP)
    .map((item, index) => ({ ...item, id: `s${index + 1}` }));
  let note: string | null = null;
  if (ordered.length > 0 && ordered.length < 3) note = `Only ${ordered.length} fitting action${ordered.length === 1 ? "" : "s"} right now.`;
  return { suggestions: ordered, note };
}
