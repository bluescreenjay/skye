// The 30-tool catalog (specs/010b-mcp-action-tools/contracts/tools.md). Metadata and schemas live
// here; execute is a stub until a story wires the real function. The person never sees this list.
import type { BrowserIntent, ExternalLink, IntegrationId, ToolResult, ToolStepNote } from "@ai-browser/shared";
import { executeListTabs } from "./tools/local/list-tabs";
import { executeReadPages } from "./tools/local/read-pages";
import { executeWriteSummary } from "./tools/local/write-summary";
import { executeExportMarkdown, executeExportPdf } from "./tools/local/export-markdown";
import { executeOpenTabs, executeOpenSearches } from "./tools/local/open-tabs";
import { executeSaveQueries } from "./tools/local/save-queries";
import { executeAppendPlan } from "./tools/local/append-plan";
import { executeSaveRefs } from "./tools/local/save-refs";
import { executeCopyText, executeComposeShare } from "./tools/local/copy-text";
import { executeSendPreview, executeMailSearch } from "./tools/local/gmail";
import { integrationExecute } from "./tools/integration";
import { executeCalendarList } from "./tools/calendar";
import {
  BODY_CHARS,
  COPY_TEXT_CHARS,
  FILENAME_CHARS,
  GIST_CHARS,
  MESSAGE_CHARS,
  PAGE_READ_MAX,
  PLAN_ITEM_CHARS,
  PLAN_ITEMS_PER_CLICK,
  QUERY_MAX,
  QUERY_MIN,
  QUOTE_MAX,
  QUOTE_MIN,
  REFS_PER_CLICK,
  SAVE_QUERIES_PER_CLICK,
  SEARCHES_OPENED_MAX,
  TABS_OPENED_MAX,
  TITLE_CHARS,
  EVENT_LOCATION_CHARS,
  EVENT_NOTES_CHARS,
} from "./limits";

export type ToolEffectClass = "read" | "write" | "send";

export interface ArgFlags {
  visible?: boolean;
  prefillOnly?: boolean;
  target?: boolean;
}

export interface JsonSchema {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  enum?: string[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolInputSchema {
  type: "object";
  additionalProperties: false;
  required: string[];
  properties: Record<string, JsonSchema>;
}

export interface AccessFacts {
  hasSummary: boolean;
  hasWebTabs: boolean;
  queryCount: number;
  planCount: number;
}

export interface ToolExecuteContext {
  userId: string;
  workspaceId: string;
  workspaceName: string;
  args: Record<string, unknown>;
  signal: AbortSignal;
}

export interface ToolExecuteResult {
  result: ToolResult;
  links?: ExternalLink[];
  intents?: BrowserIntent[];
  steps?: ToolStepNote[];
}

export interface ToolDef {
  id: string;
  label: string;
  description: string;
  integration: IntegrationId | null;
  effect: ToolEffectClass;
  helper: boolean;
  ownerOnly: boolean;
  inputSchema: ToolInputSchema;
  argFlags: Record<string, ArgFlags>;
  /** Return a fixed refusal sentence, or null if the tool may run. */
  preconditions: (facts: AccessFacts) => string | null;
  execute: (ctx: ToolExecuteContext) => Promise<ToolExecuteResult>;
}

async function notImplemented(): Promise<ToolExecuteResult> {
  throw new Error("not_implemented");
}

const emptySchema = (): ToolInputSchema => ({
  type: "object",
  additionalProperties: false,
  required: [],
  properties: {},
});

function str(min: number, max: number): JsonSchema {
  return { type: "string", minLength: min, maxLength: max };
}

function local(
  partial: Omit<ToolDef, "execute" | "integration" | "ownerOnly" | "helper" | "argFlags" | "preconditions"> & {
    helper?: boolean;
    argFlags?: Record<string, ArgFlags>;
    preconditions?: ToolDef["preconditions"];
    execute?: ToolDef["execute"];
  },
): ToolDef {
  return {
    execute: notImplemented,
    integration: null,
    ownerOnly: false,
    helper: partial.helper ?? false,
    argFlags: partial.argFlags ?? {},
    preconditions: partial.preconditions ?? (() => null),
    ...partial,
  };
}

function ext(
  integration: IntegrationId,
  partial: Omit<ToolDef, "execute" | "integration" | "ownerOnly" | "helper" | "argFlags" | "preconditions"> & {
    helper?: boolean;
    ownerOnly?: boolean;
    argFlags?: Record<string, ArgFlags>;
    preconditions?: ToolDef["preconditions"];
    execute?: ToolDef["execute"];
  },
): ToolDef {
  return {
    execute: partial.execute ?? integrationExecute(partial.id),
    helper: partial.helper ?? false,
    ownerOnly: partial.ownerOnly ?? false,
    argFlags: partial.argFlags ?? {},
    preconditions: partial.preconditions ?? (() => null),
    integration,
    ...partial,
  };
}

const needsSummary: ToolDef["preconditions"] = (facts) => (facts.hasSummary ? null : "Write a summary first.");
const needsWebTabs: ToolDef["preconditions"] = (facts) =>
  facts.hasWebTabs ? null : "Add some web tabs to this workspace first.";
const needsQueryRoom: ToolDef["preconditions"] = (facts) =>
  facts.queryCount < 10 ? null : "This workspace already has as many saved searches as it can keep.";
const needsPlanRoom: ToolDef["preconditions"] = (facts) =>
  facts.planCount < 30 ? null : "This workspace already has as many next steps as it can keep.";

const TOOLS: ToolDef[] = [
  local({
    id: "list_workspace_tabs",
    label: "List this workspace's tabs",
    description: "List the tabs saved in this workspace (title, address, short excerpt).",
    effect: "read",
    helper: true,
    inputSchema: emptySchema(),
    execute: executeListTabs,
  }),
  local({
    id: "read_public_pages",
    label: "Read public pages",
    description: "Read the text of a few of this workspace's public web pages.",
    effect: "read",
    helper: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["tabs"],
      properties: { tabs: { type: "array", minItems: 1, maxItems: PAGE_READ_MAX, items: str(1, 8) } },
    },
    preconditions: needsWebTabs,
    execute: executeReadPages,
  }),
  local({
    id: "write_summary",
    label: "Write a summary",
    description: "Write and save a summary of this workspace.",
    effect: "write",
    inputSchema: emptySchema(),
    preconditions: needsWebTabs,
    execute: executeWriteSummary,
  }),
  local({
    id: "export_summary_markdown",
    label: "Save summary as Markdown",
    description: "Download the saved summary as a Markdown file.",
    effect: "write",
    inputSchema: emptySchema(),
    preconditions: needsSummary,
    execute: executeExportMarkdown,
  }),
  local({
    id: "export_summary_pdf",
    label: "Save summary as PDF",
    description: "Download the saved summary as a simple PDF.",
    effect: "write",
    inputSchema: emptySchema(),
    preconditions: needsSummary,
    execute: executeExportPdf,
  }),
  local({
    id: "open_related_tabs",
    label: "Open related pages",
    description: "Open a few related public pages as new tabs.",
    effect: "write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["urls"],
      properties: {
        urls: { type: "array", minItems: 1, maxItems: TABS_OPENED_MAX, items: str(8, 500) },
        placeInWorkspace: { type: "boolean" },
      },
    },
    argFlags: { urls: { visible: true, prefillOnly: true } },
    execute: executeOpenTabs,
  }),
  local({
    id: "open_google_searches",
    label: "Open Google searches",
    description: "Open Google search pages for a few queries.",
    effect: "write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["queries"],
      properties: {
        queries: { type: "array", minItems: 1, maxItems: SEARCHES_OPENED_MAX, items: str(QUERY_MIN, QUERY_MAX) },
        placeInWorkspace: { type: "boolean" },
      },
    },
    argFlags: { queries: { visible: true, prefillOnly: true } },
    execute: executeOpenSearches,
  }),
  local({
    id: "save_search_queries",
    label: "Save these searches",
    description: "Save search queries on this workspace for chat and agents.",
    effect: "write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["queries"],
      properties: { queries: { type: "array", minItems: 1, maxItems: SAVE_QUERIES_PER_CLICK, items: str(QUERY_MIN, QUERY_MAX) } },
    },
    preconditions: needsQueryRoom,
    execute: executeSaveQueries,
  }),
  local({
    id: "append_plan_items",
    label: "Add these as next steps",
    description: "Add proposed steps to this workspace's checklist.",
    effect: "write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: { items: { type: "array", minItems: 1, maxItems: PLAN_ITEMS_PER_CLICK, items: str(1, PLAN_ITEM_CHARS) } },
    },
    preconditions: needsPlanRoom,
    execute: executeAppendPlan,
  }),
  local({
    id: "save_refs",
    label: "Save these quotes",
    description: "Save quotes with their source addresses as references.",
    effect: "write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["refs"],
      properties: {
        refs: {
          type: "array",
          minItems: 1,
          maxItems: REFS_PER_CLICK,
          items: {
            type: "object",
            required: ["quote", "tab"],
            properties: { quote: str(QUOTE_MIN, QUOTE_MAX), tab: str(1, 8) },
          },
        },
      },
    },
    preconditions: needsWebTabs,
    execute: executeSaveRefs,
  }),
  local({
    id: "copy_text",
    label: "Copy this text",
    description: "Offer the saved summary (or given text) to copy.",
    effect: "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: { text: str(1, COPY_TEXT_CHARS) },
    },
    preconditions: (facts) => (facts.hasSummary ? null : "Write a summary first."),
    execute: executeCopyText,
  }),
  local({
    id: "compose_share_link",
    label: "Compose a share bundle",
    description: "Compose a plain-text bundle of the workspace name, key links, and a summary blurb.",
    effect: "read",
    inputSchema: emptySchema(),
    preconditions: needsSummary,
    execute: executeComposeShare,
  }),
  ext("github", {
    id: "github_create_issue",
    label: "Create a GitHub issue",
    description: "Create an issue in the configured repository.",
    effect: "write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "body"],
      properties: { title: str(1, TITLE_CHARS), body: str(1, BODY_CHARS) },
    },
  }),
  ext("github", {
    id: "github_create_gist",
    label: "Create a GitHub gist",
    description: "Create a secret gist from workspace material.",
    effect: "write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["filename", "content"],
      properties: { filename: str(1, FILENAME_CHARS), content: str(1, GIST_CHARS), description: str(0, TITLE_CHARS) },
    },
  }),
  ext("github", {
    id: "github_search",
    label: "Search GitHub",
    description: "Search issues or code in the configured repository.",
    effect: "read",
    helper: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: { query: str(QUERY_MIN, TITLE_CHARS), kind: { type: "string", enum: ["issues", "code"] } },
    },
  }),
  ext("github", {
    id: "github_comment_on_issue",
    label: "Comment on a GitHub issue",
    description: "Add a comment on an issue in the configured repository.",
    effect: "write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["issue", "body"],
      properties: { issue: { type: "integer", minimum: 1 }, body: str(1, MESSAGE_CHARS) },
    },
    argFlags: { issue: { target: true } },
  }),
  ext("jira", {
    id: "jira_create_issue",
    label: "Create a Jira issue",
    description: "Create an issue in the configured Jira project.",
    effect: "write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: { summary: str(1, TITLE_CHARS), description: str(0, BODY_CHARS), type: str(1, 40) },
    },
  }),
  ext("jira", {
    id: "jira_search",
    label: "Search Jira",
    description: "Search issues in the configured Jira project.",
    effect: "read",
    helper: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: str(QUERY_MIN, TITLE_CHARS) },
    },
  }),
  ext("jira", {
    id: "jira_add_comment",
    label: "Comment on a Jira issue",
    description: "Add a comment on a Jira issue in the configured project.",
    effect: "write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["key", "body"],
      properties: { key: str(3, 32), body: str(1, MESSAGE_CHARS) },
    },
    argFlags: { key: { target: true } },
  }),
  ext("notion", {
    id: "notion_create_page",
    label: "Save to Notion",
    description: "Create a Notion page under the configured parent.",
    effect: "write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title"],
      properties: { title: str(1, TITLE_CHARS), content: str(0, BODY_CHARS) },
    },
  }),
  ext("notion", {
    id: "notion_append_blocks",
    label: "Append to a Notion page",
    description: "Append content to a Notion page this workspace created.",
    effect: "write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["page", "content"],
      properties: { page: str(1, 80), content: str(1, BODY_CHARS) },
    },
    argFlags: { page: { target: true } },
  }),
  ext("notion", {
    id: "notion_search",
    label: "Search Notion",
    description: "Search pages under the configured Notion parent.",
    effect: "read",
    helper: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: str(QUERY_MIN, TITLE_CHARS) },
    },
  }),
  ext("slack", {
    id: "slack_post_message",
    label: "Post to Slack",
    description: "Post a message to the configured Slack channel.",
    effect: "write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: str(1, MESSAGE_CHARS) },
    },
  }),
  ext("slack", {
    id: "slack_upload_snippet",
    label: "Upload a Slack snippet",
    description: "Upload a text snippet to the configured Slack channel.",
    effect: "write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["filename", "content"],
      properties: { filename: str(1, FILENAME_CHARS), content: str(1, GIST_CHARS), title: str(0, TITLE_CHARS) },
    },
  }),
  ext("drive", {
    id: "drive_upload_markdown",
    label: "Save summary to Drive",
    description: "Upload the saved summary as a Markdown file in Drive.",
    effect: "write",
    ownerOnly: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: { filename: str(1, FILENAME_CHARS) },
    },
    preconditions: needsSummary,
  }),
  ext("drive", {
    id: "drive_create_doc_from_summary",
    label: "Create a Drive doc",
    description: "Create a Google Doc from the saved summary.",
    effect: "write",
    ownerOnly: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: { title: str(1, TITLE_CHARS) },
    },
    preconditions: needsSummary,
  }),
  ext("drive", {
    id: "drive_get_share_link",
    label: "Get a Drive share link",
    description: "Get a share link for a Drive file this workspace created.",
    effect: "read",
    ownerOnly: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["file"],
      properties: { file: str(1, 80) },
    },
    argFlags: { file: { target: true } },
  }),
  ext("gmail", {
    id: "gmail_create_draft",
    label: "Draft an email",
    description: "Create a Gmail draft from workspace material. Sends nothing.",
    effect: "write",
    ownerOnly: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["subject", "body"],
      properties: { subject: str(1, TITLE_CHARS), body: str(1, BODY_CHARS), to: str(3, 200) },
    },
  }),
  ext("gmail", {
    id: "gmail_send_message",
    label: "Send an email",
    description: "Prepare an email to confirm and send. A click never sends.",
    effect: "send",
    ownerOnly: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["subject", "body"],
      properties: { subject: str(1, TITLE_CHARS), body: str(1, BODY_CHARS), to: str(3, 200) },
    },
    argFlags: { to: { visible: true, prefillOnly: true } },
    execute: executeSendPreview,
  }),
  ext("gmail", {
    id: "gmail_search_messages",
    label: "Search mail",
    description: "Search the owner's mail. Results are shown once and never saved.",
    effect: "read",
    ownerOnly: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: str(QUERY_MIN, TITLE_CHARS) },
    },
    execute: executeMailSearch,
  }),
  ext("calendar", {
    id: "calendar_create_event",
    label: "Add to my calendar",
    description:
      "Put ONE event on the owner's own calendar, for them alone (no guests, no invitations). Needs a title and a start: a day (2026-10-03, an all-day event) or a day and time (2026-10-03T09:30). The end is optional and defaults to one hour later.",
    effect: "write",
    ownerOnly: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "start"],
      properties: {
        title: str(1, TITLE_CHARS),
        start: str(10, 40),
        end: str(10, 40),
        location: str(0, EVENT_LOCATION_CHARS),
        notes: str(0, EVENT_NOTES_CHARS),
      },
    },
    argFlags: { title: { visible: true }, start: { visible: true } },
  }),
  ext("calendar", {
    id: "calendar_list_events",
    label: "What's on my calendar",
    description:
      "Show the owner the next few events on their own calendar, for a week from a chosen day (2026-10-03; today when omitted). Shown once and never saved or read by the AI.",
    effect: "read",
    ownerOnly: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: { day: str(10, 10) },
    },
    execute: executeCalendarList,
  }),
];

const BY_ID = new Map(TOOLS.map((tool) => [tool.id, tool]));

export const HELPER_IDS = [
  "list_workspace_tabs",
  "read_public_pages",
  "github_search",
  "jira_search",
  "notion_search",
] as const;

export function allTools(): ToolDef[] {
  return TOOLS;
}

export function getTool(id: string): ToolDef | undefined {
  return BY_ID.get(id);
}

/** Replace a tool's execute (stories wire real implementations; tests may too). */
export function setToolExecute(id: string, execute: ToolDef["execute"]): void {
  const tool = BY_ID.get(id);
  if (!tool) throw new Error(`unknown tool ${id}`);
  tool.execute = execute;
}
