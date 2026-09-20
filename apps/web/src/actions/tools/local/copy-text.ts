import { listSummary } from "../../notes";
import { SHARE_ADDRESSES_MAX, SHARE_BLURB_CHARS } from "../../limits";
import { gatherMaterial } from "../../../agents/context";
import type { ToolExecuteContext, ToolExecuteResult } from "../../registry";

export async function executeCopyText(ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
  const given = typeof ctx.args.text === "string" ? ctx.args.text : null;
  const summary = await listSummary(ctx.userId, ctx.workspaceId);
  const text = given ?? summary?.text ?? "";
  if (!text) throw new Error("no_summary");
  return { result: { kind: "copy", text } };
}

function cutBlurb(text: string): string {
  if (text.length <= SHARE_BLURB_CHARS) return text;
  const sliced = text.slice(0, SHARE_BLURB_CHARS);
  const sentence = sliced.lastIndexOf(". ");
  const word = sliced.lastIndexOf(" ");
  const at = sentence >= 40 ? sentence + 1 : word >= 40 ? word : SHARE_BLURB_CHARS;
  return `${sliced.slice(0, at).trim()}…`;
}

export async function executeComposeShare(ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
  const summary = await listSummary(ctx.userId, ctx.workspaceId);
  if (!summary) throw new Error("no_summary");
  const gathered = await gatherMaterial(ctx.userId, { id: ctx.workspaceId, name: ctx.workspaceName });
  const links = gathered.tabs.slice(0, SHARE_ADDRESSES_MAX).map((tab) => tab.url);
  const text = `${ctx.workspaceName}\n${links.join("\n")}\n\n${cutBlurb(summary.text)}`;
  return { result: { kind: "text", text } };
}
