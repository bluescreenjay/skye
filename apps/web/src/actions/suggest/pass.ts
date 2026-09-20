// One suggestion pass: gather, one AI request, validate, store (research 5). Never runs a tool.
import type { SuggestionSet } from "@ai-browser/shared";
import type { DbWorkspace } from "../../map";
import { gatherMaterial } from "../../agents/context";
import { ModelUnconfiguredError } from "../../llm/errors";
import { allowedTools, connectedIntegrations } from "../access";
import { SUGGEST_DEADLINE_MS, SUGGEST_REFRESH_GAP_S, suggestReuseS, TAB_EXCERPT_CHARS } from "../limits";
import { getActionModel } from "../model";
import { listQueries, listSummary } from "../notes";
import { isOwner } from "../integrations/config";
import { fingerprintOf, getCached, setCached } from "./cache";
import { buildSuggestPrompt, SUGGEST_SCHEMA, toolsForPrompt, type SuggestData } from "./prompt";
import { validateSuggestions } from "./validate";

const FAILED_NOTE = "Couldn't pick actions right now. Try refresh.";
const SUMMARY_EXCERPT = 1_200;

function failedSet(): SuggestionSet {
  return { status: "failed", suggestions: [], generatedAt: new Date().toISOString(), reused: false, note: FAILED_NOTE };
}

export async function runSuggestPass(options: {
  userId: string;
  workspace: Pick<DbWorkspace, "id" | "name">;
  force: boolean;
}): Promise<SuggestionSet> {
  const { userId, workspace, force } = options;
  const existing = getCached(userId, workspace.id);
  if (existing?.inflight) return existing.inflight;

  let settle!: (set: SuggestionSet) => void;
  let fail!: (error: unknown) => void;
  const inflight = new Promise<SuggestionSet>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  setCached(userId, workspace.id, {
    suggestions: existing?.suggestions ?? failedSet(),
    fingerprint: existing?.fingerprint ?? "",
    generatedAt: existing?.generatedAt ?? 0,
    inflight,
  });

  const work = (async (): Promise<SuggestionSet> => {
    try {
      const gathered = await gatherMaterial(userId, workspace);
      const summary = await listSummary(userId, workspace.id);
      const queries = await listQueries(userId, workspace.id);
      const facts = {
        hasSummary: summary !== null,
        hasWebTabs: gathered.tabs.length > 0,
        queryCount: queries.length,
        planCount: gathered.plan.length,
      };
      const allowed = allowedTools(userId, facts);
      const connected = connectedIntegrations(userId);
      const fingerprint = fingerprintOf({
        tabs: gathered.tabs.map((t) => ({ id: t.id, title: t.title })),
        summaryUpdatedAt: summary?.updatedAt ?? null,
        plan: gathered.plan,
        queries,
        connected,
        owner: isOwner(userId),
      });
      const reuseWindowS = force ? SUGGEST_REFRESH_GAP_S : suggestReuseS();
      const cached = getCached(userId, workspace.id);
      if (cached && cached.fingerprint === fingerprint && reuseWindowS > 0) {
        const ageS = (Date.now() - cached.generatedAt) / 1000;
        if (ageS < reuseWindowS && cached.suggestions.status === "ok") {
          return { ...cached.suggestions, reused: true };
        }
      }

      const model = getActionModel();
      const data: SuggestData = {
        workspace: { name: gathered.workspaceName, tabsTotal: gathered.tabsTotal, tabsShown: gathered.tabs.length },
        tabs: gathered.tabs.map((t) => ({
          id: t.id,
          title: t.title,
          url: t.url,
          excerpt: t.excerpt.slice(0, TAB_EXCERPT_CHARS),
        })),
        summary: { exists: summary !== null, text: (summary?.text ?? "").slice(0, SUMMARY_EXCERPT) },
        plan: gathered.plan,
        savedQueries: queries,
        connected,
        tools: toolsForPrompt(allowed),
      };
      const prompt = buildSuggestPrompt(data);
      const raw = await model.suggest({ prompt, schema: SUGGEST_SCHEMA }, AbortSignal.timeout(SUGGEST_DEADLINE_MS));
      const { suggestions, note } = validateSuggestions(raw, allowed, facts, {
        summary: summary?.text ?? "",
        workspace: gathered.workspaceName,
      });
      if (suggestions.length === 0) return failedSet();
      const set: SuggestionSet = {
        status: "ok",
        suggestions,
        generatedAt: new Date().toISOString(),
        reused: false,
        note,
      };
      setCached(userId, workspace.id, { suggestions: set, fingerprint, generatedAt: Date.now(), inflight: null });
      return set;
    } catch (error) {
      if (error instanceof ModelUnconfiguredError) throw error;
      return failedSet();
    }
  })();

  void work.then(
    (set) => {
      const latest = getCached(userId, workspace.id);
      if (latest) latest.inflight = null;
      settle(set);
    },
    (error) => {
      const latest = getCached(userId, workspace.id);
      if (latest) latest.inflight = null;
      fail(error);
    },
  );
  return inflight;
}
