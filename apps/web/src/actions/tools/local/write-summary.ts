import { getAgent } from "../../../agents/catalog";
import { gatherMaterial } from "../../../agents/context";
import { getAgentModel } from "../../../agents/model";
import { produceOutput } from "../../../agents/run";
import { upsertSummary } from "../../notes";
import type { ToolExecuteContext, ToolExecuteResult } from "../../registry";

export async function executeWriteSummary(ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
  const gathered = await gatherMaterial(ctx.userId, { id: ctx.workspaceId, name: ctx.workspaceName });
  const agent = getAgent("summarize")!;
  const model = getAgentModel();
  const produced = await produceOutput(agent, gathered, model, ctx.signal);
  if (produced.result.kind !== "text") {
    throw new Error("bad_answer");
  }
  const unreadable = produced.sources.filter((source) => source.read !== "page").length;
  await upsertSummary(ctx.userId, ctx.workspaceId, produced.result.text, {
    coverage: produced.coverage,
    unreadable,
    cited: produced.result.cited,
  });
  return {
    result: {
      kind: "summary",
      text: produced.result.text,
      coverage: produced.coverage,
      unreadable,
    },
  };
}
