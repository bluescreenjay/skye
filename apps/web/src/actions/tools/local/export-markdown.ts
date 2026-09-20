import { randomUUID } from "crypto";
import { listSummary } from "../../notes";
import type { ToolExecuteContext, ToolExecuteResult } from "../../registry";

function filenameOf(workspaceName: string, ext: "md" | "pdf"): string {
  const safe = workspaceName.replace(/[^A-Za-z0-9 -]/g, "").trim() || "workspace";
  return `${safe}-summary.${ext}`;
}

export async function executeExportMarkdown(ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
  const summary = await listSummary(ctx.userId, ctx.workspaceId);
  if (!summary) throw new Error("no_summary");
  const filename = filenameOf(ctx.workspaceName, "md");
  const body = `# ${ctx.workspaceName}\n\n${summary.text}\n\nread ${summary.coverage.pagesRead} of ${summary.coverage.tabsIncluded} tabs\n`;
  return {
    result: { kind: "file", format: "md", filename, bytes: Buffer.byteLength(body) },
    intents: [{ id: randomUUID(), kind: "download", format: "md", filename }],
  };
}

export async function executeExportPdf(ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
  const summary = await listSummary(ctx.userId, ctx.workspaceId);
  if (!summary) throw new Error("no_summary");
  const { writeSimplePdf } = await import("../pdf");
  const filename = filenameOf(ctx.workspaceName, "pdf");
  const pdf = writeSimplePdf(ctx.workspaceName, summary.text);
  return {
    result: { kind: "file", format: "pdf", filename, bytes: pdf.bytes.length },
    intents: [{ id: randomUUID(), kind: "download", format: "pdf", filename }],
  };
}
