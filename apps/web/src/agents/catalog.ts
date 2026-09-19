// The fixed list of agents (spec FR-001): one-shot tools, not autonomous programs. Each is one
// task text and one strict answer shape; the answer is validated by validate.ts. People cannot
// add, edit, or remove agents.
import type { AgentDescriptor, AgentId, AgentKind } from "@ai-browser/shared";

export interface AgentDef extends AgentDescriptor {
  /** The one paragraph that names this agent's task in the prompt. */
  task: string;
  /** A strict JSON Schema (standard dialect; each provider translates it). Lengths are enforced by validate.ts, not here. */
  schema: unknown;
}

const strings = { type: "array", items: { type: "string" } };

const SCHEMAS: Record<AgentKind, unknown> = {
  text: {
    type: "object",
    additionalProperties: false,
    required: ["text", "cited"],
    properties: { text: { type: "string" }, cited: strings },
  },
  comparison: {
    type: "object",
    additionalProperties: false,
    required: ["criteria", "options", "verdict"],
    properties: {
      criteria: strings,
      options: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "tab", "values"],
          properties: { name: { type: "string" }, tab: { type: ["string", "null"] }, values: strings },
        },
      },
      verdict: { type: "string" },
    },
  },
  checklist: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: { items: strings },
  },
  quotes: {
    type: "object",
    additionalProperties: false,
    required: ["quotes"],
    properties: {
      quotes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["quote", "tab"],
          properties: { quote: { type: "string" }, tab: { type: "string" } },
        },
      },
    },
  },
};

const def = (id: AgentId, name: string, description: string, kind: AgentKind, task: string): AgentDef => ({
  id,
  name,
  description,
  kind,
  task,
  schema: SCHEMAS[kind],
});

export const AGENTS: AgentDef[] = [
  def(
    "summarize",
    "summarize",
    "a short summary of what your sources say",
    "text",
    'Write a short summary of what the sources say, grouped by theme. Name the tabs you draw on by citing their ids in "cited". Return the summary as plain text in "text" (short paragraphs, or lines starting with "- ").',
  ),
  def(
    "compare",
    "compare",
    "the options side by side",
    "comparison",
    'Compare the options, products, or places the tabs are about. Give 2 to 6 short "criteria", then one row per option with its "name", the "tab" id it comes from (or null), and one short value per criterion in "values" (same order and count as the criteria). End with a one or two sentence "verdict" that says what the material supports and where it is thin.',
  ),
  def(
    "missing",
    "what's missing",
    "what your research doesn't cover yet",
    "text",
    'Say what the research does not cover yet, given the tabs, the plan items, and the conversation: gaps, unanswered questions, and things worth checking. Cite the tabs you rely on in "cited" and return plain text in "text".',
  ),
  def(
    "next-steps",
    "next steps",
    "a short checklist of what to do next",
    "checklist",
    'List 5 to 8 concrete next actions for this workspace, each one short and specific. Do not repeat plan items that are already done, and take into account what the conversation already settled. Return them in "items".',
  ),
  def(
    "refs",
    "collect refs",
    "key quotes, with where they came from",
    "quotes",
    'Collect up to 10 short, exact quotes worth keeping. Each quote must be copied word for word from the text of the tab you cite in "tab". Do not paraphrase, and do not quote from tabs that only have an excerpt unless the words are in that excerpt.',
  ),
];

export const AGENT_IDS: AgentId[] = AGENTS.map((a) => a.id);

export function getAgent(id: string): AgentDef | undefined {
  return AGENTS.find((a) => a.id === id);
}
