import { addQueries } from "../../notes";
import type { ToolExecuteContext, ToolExecuteResult } from "../../registry";

export async function executeSaveQueries(ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
  const queries = Array.isArray(ctx.args.queries) ? (ctx.args.queries as string[]) : [];
  const count = await addQueries(ctx.userId, ctx.workspaceId, queries);
  return { result: { kind: "saved", what: "queries", ...count } };
}
