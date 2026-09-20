import { ActionRequestError, invalidFormat, noSummary, notAWorkspace } from "@/src/actions/errors";
import { listSummary } from "@/src/actions/notes";
import { writeSimplePdf } from "@/src/actions/tools/pdf";
import { requireUser } from "@/src/auth";
import { findWorkspace } from "@/src/chat/messages";
import { corsHeaders, errorJson, json, optionsResponse } from "@/src/json";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export function OPTIONS() {
  return optionsResponse();
}

function filenameOf(name: string, ext: string): string {
  const safe = name.replace(/[^A-Za-z0-9 -]/g, "").trim() || "workspace";
  return `${safe}-summary.${ext}`;
}

export async function GET(request: Request, context: Context) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  const { id } = await context.params;
  if (id === "other") {
    const refused = notAWorkspace();
    return json({ error: refused.message, code: refused.code }, refused.status);
  }
  const workspace = await findWorkspace(user!.id, id);
  if (!workspace) return errorJson("Workspace not found", 404);
  const format = new URL(request.url).searchParams.get("format");
  if (format !== "md" && format !== "pdf") {
    const err = invalidFormat();
    return json({ error: err.message, code: err.code }, err.status);
  }
  const summary = await listSummary(user!.id, workspace.id);
  if (!summary) {
    const err = noSummary();
    return json({ error: err.message, code: err.code }, err.status);
  }
  const filename = filenameOf(workspace.name, format);
  const headers = {
    ...corsHeaders(),
    "Cache-Control": "no-store",
    "Content-Disposition": `attachment; filename="${filename}"`,
  };
  if (format === "md") {
    const body = `# ${workspace.name}\n\n${summary.text}\n\nread ${summary.coverage.pagesRead} of ${summary.coverage.tabsIncluded} tabs\n`;
    return new Response(body, { status: 200, headers: { ...headers, "Content-Type": "text/markdown; charset=utf-8" } });
  }
  const pdf = writeSimplePdf(workspace.name, summary.text);
  return new Response(Buffer.from(pdf.bytes), { status: 200, headers: { ...headers, "Content-Type": "application/pdf" } });
}
