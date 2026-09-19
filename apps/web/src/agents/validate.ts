// Turns the AI's raw JSON answer into a stored result (data-model.md "Answer shapes" and
// "Validation rules"). The model cites tabs by short id (t1, t2, ...); the server maps ids back to
// title and plain address and drops anything it cannot verify. Quotes are the important case:
// a quote is kept only if it really appears in the material of the tab it cites (spec SC-003).
import type { AgentResult, AgentTabRef } from "@ai-browser/shared";
import type { AgentDef } from "./catalog";
import { CHECKLIST_ITEM_CHARS, CHECKLIST_MAX_ITEMS } from "./limits";
import { AnswerError } from "./errors";

export { AnswerError };

/** What the model was given for one tab, and what a quote may be checked against. */
export interface MaterialTab {
  id: string;
  title: string;
  /** The plain address. */
  url: string;
  /** Page text when it was read, otherwise the stored excerpt. */
  material: string;
}

const TEXT_MAX = 3_000;
const CRITERIA_MAX = 6;
const OPTIONS_MAX = 8;
const NAME_MAX = 120;
const VALUE_MAX = 300;
const VERDICT_MAX = 600;
const QUOTE_MIN = 10;
const QUOTE_MAX = 300;
const QUOTES_MAX = 10;

/** Case, whitespace runs, curly versus straight quotes, and dash variants are ignored when matching a quote. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
const cut = (text: string, max: number) => (text.length > max ? text.slice(0, max).trimEnd() : text);

export function validateAnswer(agent: AgentDef, answer: unknown, tabs: MaterialTab[]): AgentResult {
  if (!isObject(answer)) throw new AnswerError();
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const ref = (id: unknown): AgentTabRef | null => {
    const tab = typeof id === "string" ? byId.get(id) : undefined;
    return tab ? { title: tab.title, url: tab.url } : null;
  };

  switch (agent.kind) {
    case "text": {
      const text = typeof answer.text === "string" ? cut(answer.text.trim(), TEXT_MAX) : "";
      if (text === "") throw new AnswerError();
      const cited: AgentTabRef[] = [];
      for (const id of strings(answer.cited)) {
        const found = ref(id);
        if (found && !cited.some((c) => c.url === found.url && c.title === found.title)) cited.push(found);
      }
      return { kind: "text", text, cited };
    }

    case "comparison": {
      const rawCriteria = Array.isArray(answer.criteria) ? answer.criteria : [];
      const keep: number[] = [];
      rawCriteria.forEach((c, i) => {
        if (typeof c === "string" && c.trim() !== "" && keep.length < CRITERIA_MAX) keep.push(i);
      });
      if (keep.length < 2) throw new AnswerError();
      const criteria = keep.map((i) => cut((rawCriteria[i] as string).trim(), NAME_MAX));
      const options: { name: string; tab: AgentTabRef | null; values: string[] }[] = [];
      for (const row of Array.isArray(answer.options) ? answer.options : []) {
        if (!isObject(row) || options.length >= OPTIONS_MAX) continue;
        const name = typeof row.name === "string" ? cut(row.name.trim(), NAME_MAX) : "";
        const values = Array.isArray(row.values) ? row.values : [];
        if (name === "" || values.length !== rawCriteria.length) continue; // a row must answer every criterion
        options.push({ name, tab: ref(row.tab), values: keep.map((i) => cut(String(values[i] ?? "").trim(), VALUE_MAX)) });
      }
      if (options.length === 0) throw new AnswerError();
      const verdict = typeof answer.verdict === "string" ? cut(answer.verdict.trim(), VERDICT_MAX) : "";
      return { kind: "comparison", criteria, options, verdict };
    }

    case "checklist": {
      const items: string[] = [];
      for (const raw of strings(answer.items)) {
        const item = cut(raw.trim(), CHECKLIST_ITEM_CHARS);
        if (item === "" || items.some((i) => i.toLowerCase() === item.toLowerCase())) continue;
        items.push(item);
        if (items.length === CHECKLIST_MAX_ITEMS) break;
      }
      if (items.length === 0) throw new AnswerError();
      return { kind: "checklist", items };
    }

    case "quotes": {
      const raw = Array.isArray(answer.quotes) ? answer.quotes : [];
      const kept: { quote: string; tab: AgentTabRef }[] = [];
      const seen = new Set<string>();
      let dropped = 0;
      for (const entry of raw) {
        const quote = isObject(entry) && typeof entry.quote === "string" ? entry.quote.trim() : "";
        const tab = isObject(entry) && typeof entry.tab === "string" ? byId.get(entry.tab) : undefined;
        const normalized = normalizeForMatch(quote);
        const verified = tab !== undefined && quote.length >= QUOTE_MIN && quote.length <= QUOTE_MAX && normalizeForMatch(`${tab.title}\n${tab.material}`).includes(normalized);
        if (!tab || !verified) {
          dropped += 1; // fabricated, from another tab, unknown tab, or the wrong length
          continue;
        }
        if (seen.has(`${tab.id}|${normalized}`) || kept.length >= QUOTES_MAX) continue; // a repeat, or beyond the cap: not "unverified"
        seen.add(`${tab.id}|${normalized}`);
        kept.push({ quote, tab: { title: tab.title, url: tab.url } });
      }
      const note =
        dropped > 0
          ? dropped === 1
            ? "1 quote could not be verified and was left out."
            : `${dropped} quotes could not be verified and were left out.`
          : kept.length === 0
            ? "No quotable text was found in the material."
            : null;
      return { kind: "quotes", quotes: kept, note };
    }
  }
}
