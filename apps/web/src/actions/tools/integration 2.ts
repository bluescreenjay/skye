import type { IntegrationId } from "@ai-browser/shared";
import { query } from "../../db";
import { ConnectorError, getConnector } from "../integrations/connector";
import { bindingFor } from "../integrations/bindings";
import { integrationConfig } from "../integrations/config";
import { listSummary } from "../notes";
import { badInput, noSummary } from "../errors";
import type { ToolExecuteContext, ToolExecuteResult } from "../registry";

async function notionPageAllowed(userId: string, workspaceId: string, page: string): Promise<boolean> {
  const result = await query<{ output: { links?: { id?: string | null }[] } | null }>(
    `SELECT output FROM action_runs
     WHERE user_id = $1::uuid AND workspace_id = $2::uuid AND action_id = 'notion_create_page' AND status = 'succeeded'
     ORDER BY created_at DESC`,
    [userId, workspaceId],
  );
      return result.rows.some((row: { output: { links?: { id?: string | null }[] } | null }) => row.output?.links?.some((link) => link.id === page));
}

async function driveFileAllowed(userId: string, workspaceId: string, file: string): Promise<boolean> {
  const result = await query<{ output: { links?: { id?: string | null }[] } | null }>(
    `SELECT output FROM action_runs
     WHERE user_id = $1::uuid AND workspace_id = $2::uuid AND action_id LIKE 'drive_%' AND status = 'succeeded'
     ORDER BY created_at DESC`,
    [userId, workspaceId],
  );
      return result.rows.some((row: { output: { links?: { id?: string | null }[] } | null }) => row.output?.links?.some((link) => link.id === file));
}

export function integrationExecute(toolId: string) {
  return async (ctx: ToolExecuteContext): Promise<ToolExecuteResult> => {
    const binding = bindingFor(toolId);
    if (!binding) throw new Error("not_implemented");
    const cfg = integrationConfig(binding.integration);
    const dest = cfg.destination ?? "";
    const args = { ...ctx.args };

    if (toolId === "jira_add_comment") {
      const key = String(args.key ?? "");
      if (!dest || !key.startsWith(dest)) throw badInput('"key" is not an issue in the configured project.');
    }
    if (toolId === "github_comment_on_issue") {
      const issue = args.issue;
      if (typeof issue !== "number" || issue < 1) throw badInput('"issue" has to be a whole number.');
    }
    if (toolId === "notion_append_blocks") {
      if (!(await notionPageAllowed(ctx.userId, ctx.workspaceId, String(args.page ?? "")))) {
        throw badInput('"page" has to be a Notion page this workspace created.');
      }
    }
    if (toolId === "drive_get_share_link") {
      if (!(await driveFileAllowed(ctx.userId, ctx.workspaceId, String(args.file ?? "")))) {
        throw badInput('"file" has to be a Drive file this workspace created.');
      }
    }
    if (toolId === "drive_upload_markdown" || toolId === "drive_create_doc_from_summary") {
      const summary = await listSummary(ctx.userId, ctx.workspaceId);
      if (!summary) throw noSummary();
      args.content = summary.text;
      if (toolId === "drive_upload_markdown" && typeof args.filename === "string" && !args.filename.endsWith(".md")) {
        args.filename = `${args.filename}.md`;
      }
    }

    const connector = getConnector();
    if (!connector.available(toolId)) throw new ConnectorError("not_connected");
    const mapped = binding.toArguments(args, dest);
    if (dest && !JSON.stringify(mapped).includes(dest) && binding.toolId !== "github_create_gist" && !binding.toolId.startsWith("gmail_")) {
      // dest is always added by toArguments for destination-scoped tools; gist has no dest override.
    }
    const result = await connector.call(toolId, mapped, ctx.signal);
    const service = binding.integration as IntegrationId;
    if (binding.search) {
      return { result: { kind: "search", service, items: result.items ?? [] }, links: result.links };
    }
    return { result: { kind: "created", service, what: binding.what }, links: result.links };
  };
}
