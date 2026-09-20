import { CONFIRM_WINDOW_MS, MAIL_EXCERPT_CHARS, MAIL_RESULTS_MAX } from "../../limits";
import { getConnector } from "../../integrations/connector";
import type { ToolExecuteContext, ToolExecuteResult } from "../../registry";

export async function executeSendPreview(ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
  const subject = String(ctx.args.subject ?? "");
  const body = String(ctx.args.body ?? "");
  const to = typeof ctx.args.to === "string" ? ctx.args.to : null;
  return {
    result: {
      kind: "email_preview",
      to,
      subject,
      body,
      expiresAt: new Date(Date.now() + CONFIRM_WINDOW_MS).toISOString(),
      state: "unsent",
    },
  };
}

export async function executeMailSearch(ctx: ToolExecuteContext): Promise<ToolExecuteResult & { mail?: { from: string; subject: string; date: string; excerpt: string }[] }> {
  const result = await getConnector().call("gmail_search_messages", { text: ctx.args.text }, ctx.signal);
  const mail = (result.mail ?? []).slice(0, MAIL_RESULTS_MAX).map((item) => ({
    from: item.from,
    subject: item.subject,
    date: item.date,
    excerpt: item.excerpt.slice(0, MAIL_EXCERPT_CHARS),
  }));
  return {
    result: { kind: "mail_search", shown: mail.length },
    mail,
  };
}
