// POST /api/command, the whole pipeline (specs/011-global-command-bar/contracts/http.md). It changes NOTHING.
//   1. get the model FIRST: with no key nothing is queried or sent;
//   2. read the person's own workspaces and tabs, and resolve "this workspace";
//   3. build the one prompt;
//   4. ask the model ONCE (the bar itself never retries; the shared AI layer retries only a transient
//      "busy" inside this one call, as it does for clustering and agents);
//   5. validate the answer (unknown ids and unusable fields are dropped);
//   6. resolve it into a reply built from fixed sentences.
import type { CommandContext, CommandReply } from "@ai-browser/shared";
import { query } from "../db";
import { readMaterial, resolveCurrent } from "./context";
import { abortAfterMs } from "./limits";
import { getCommandModel } from "./model";
import { buildMaterial, buildPrompt, todayIn } from "./prompt";
import { resolveInterpretation } from "./resolve";
import { ANSWER_SCHEMA } from "./schema";
import { validateAnswer } from "./validate";

export async function interpretCommand(
  userId: string,
  request: { text: string; context: CommandContext },
  now: Date = new Date(),
): Promise<CommandReply> {
  const model = getCommandModel(); // throws ModelUnconfiguredError before anything is read
  const db = { query };
  const rows = await readMaterial(db, userId);
  const current = await resolveCurrent(db, userId, request.context);
  const material = buildMaterial(rows);
  const prompt = buildPrompt(request.text, todayIn(now, request.context.timeZone), request.context.surface, material);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), abortAfterMs());
  let answer: unknown;
  try {
    answer = await model.interpret({ prompt, schema: ANSWER_SCHEMA }, controller.signal);
  } finally {
    clearTimeout(timer);
  }

  const interp = validateAnswer(answer, { text: request.text, tabIdMap: material.tabIdMap, workspaceIdMap: material.workspaceIdMap });
  const workspaces = material.workspacesData.map((w) => ({ id: material.workspaceIdMap.get(w.id)!, name: w.name }));
  return resolveInterpretation({
    userId,
    db,
    text: request.text,
    context: request.context,
    interp,
    material,
    current,
    now,
    workspaces,
    wsNames: new Map(workspaces.map((w) => [w.id, w.name])),
  });
}
