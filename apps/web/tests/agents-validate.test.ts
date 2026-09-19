import { describe, expect, it } from "vitest";
import { getAgent } from "@/src/agents/catalog";
import { AnswerError } from "@/src/agents/errors";
import { normalizeForMatch, validateAnswer, type MaterialTab } from "@/src/agents/validate";

const TABS: MaterialTab[] = [
  { id: "t1", title: "Kyoto travel guide", url: "https://a.example/kyoto", material: "Kyoto is best in autumn.\n\nThe “Golden Pavilion” opens at 9 am – 5 pm daily." },
  { id: "t2", title: "Fushimi Inari", url: "https://b.example/fushimi", material: "Thousands of torii gates climb the hill. Go early to avoid crowds." },
];
const agent = (id: string) => getAgent(id)!;
const run = (id: string, answer: unknown) => validateAnswer(agent(id), answer, TABS);

describe("text results (summarize, what's missing)", () => {
  it("trims the text, cuts it to 3,000 characters, and maps cited ids to title and plain address", () => {
    const result = run("summarize", { text: `  ${"x".repeat(4_000)}  `, cited: ["t1", "t2"] });
    expect(result.kind).toBe("text");
    if (result.kind !== "text") return;
    expect(result.text).toHaveLength(3_000);
    expect(result.cited).toEqual([
      { title: "Kyoto travel guide", url: "https://a.example/kyoto" },
      { title: "Fushimi Inari", url: "https://b.example/fushimi" },
    ]);
  });

  it("drops unknown and duplicate cited ids", () => {
    const result = run("missing", { text: "Gaps.", cited: ["t9", "t1", "t1", "nonsense", 7] });
    expect(result.kind === "text" && result.cited).toEqual([{ title: "Kyoto travel guide", url: "https://a.example/kyoto" }]);
  });

  it("an empty text, or something that is not an object, is an AnswerError", () => {
    for (const bad of [{ text: "   ", cited: [] }, { cited: [] }, null, "a string", 42, []]) {
      expect(() => run("summarize", bad)).toThrow(AnswerError);
    }
  });
});

describe("comparison results (compare)", () => {
  const good = { criteria: ["price", "crowds"], options: [{ name: "Kyoto", tab: "t1", values: ["mid", "high"] }, { name: "Fushimi", tab: "t2", values: ["free", "high"] }], verdict: "Both are busy." };

  it("keeps criteria and options, mapping each option's tab", () => {
    const result = run("compare", good);
    expect(result).toEqual({
      kind: "comparison",
      criteria: ["price", "crowds"],
      options: [
        { name: "Kyoto", tab: { title: "Kyoto travel guide", url: "https://a.example/kyoto" }, values: ["mid", "high"] },
        { name: "Fushimi", tab: { title: "Fushimi Inari", url: "https://b.example/fushimi" }, values: ["free", "high"] },
      ],
      verdict: "Both are busy.",
    });
  });

  it("an unknown tab id becomes null; a row whose values do not match the criteria is dropped", () => {
    const result = run("compare", { ...good, options: [{ name: "Nowhere", tab: "t9", values: ["a", "b"] }, { name: "Short", tab: "t1", values: ["only one"] }] });
    if (result.kind !== "comparison") throw new Error("expected comparison");
    expect(result.options).toEqual([{ name: "Nowhere", tab: null, values: ["a", "b"] }]);
  });

  it("caps criteria at 6, options at 8, and the verdict at 600 characters", () => {
    const criteria = Array.from({ length: 8 }, (_, i) => `c${i}`);
    const options = Array.from({ length: 12 }, (_, i) => ({ name: `o${i}`, tab: null, values: criteria.map((c) => `${c}-v`) }));
    const result = run("compare", { criteria, options, verdict: "v".repeat(900) });
    if (result.kind !== "comparison") throw new Error("expected comparison");
    expect(result.criteria).toHaveLength(6);
    expect(result.options).toHaveLength(8);
    expect(result.options[0].values).toHaveLength(6);
    expect(result.verdict).toHaveLength(600);
  });

  it("no surviving option, or fewer than two criteria, is an AnswerError", () => {
    expect(() => run("compare", { ...good, options: [{ name: "x", tab: null, values: ["1"] }] })).toThrow(AnswerError);
    expect(() => run("compare", { criteria: ["only"], options: [{ name: "x", tab: null, values: ["1"] }], verdict: "" })).toThrow(AnswerError);
    expect(() => run("compare", { criteria: ["a", "b"], options: [], verdict: "" })).toThrow(AnswerError);
  });
});

describe("checklist results (next steps)", () => {
  it("trims, de-duplicates case-insensitively, cuts to 200 characters, and caps at 8", () => {
    const items = ["  Book flights ", "book FLIGHTS", "x".repeat(300), ...Array.from({ length: 12 }, (_, i) => `Step ${i}`)];
    const result = run("next-steps", { items });
    if (result.kind !== "checklist") throw new Error("expected checklist");
    expect(result.items).toHaveLength(8);
    expect(result.items[0]).toBe("Book flights");
    expect(result.items[1]).toHaveLength(200);
    expect(new Set(result.items.map((i) => i.toLowerCase())).size).toBe(result.items.length);
  });

  it("no items left after cleaning is an AnswerError", () => {
    for (const bad of [{ items: [] }, { items: ["  ", ""] }, { items: "not a list" }, {}]) expect(() => run("next-steps", bad)).toThrow(AnswerError);
  });
});

describe("quotes results (collect refs): every quote must be in the material of the tab it cites", () => {
  it("keeps verbatim quotes and maps their tab", () => {
    const result = run("refs", { quotes: [{ quote: "Kyoto is best in autumn.", tab: "t1" }, { quote: "Go early to avoid crowds.", tab: "t2" }] });
    if (result.kind !== "quotes") throw new Error("expected quotes");
    expect(result.quotes.map((q) => q.tab.url)).toEqual(["https://a.example/kyoto", "https://b.example/fushimi"]);
    expect(result.note).toBeNull();
  });

  it("matches after normalizing case, whitespace, curly versus straight quotes, and dashes", () => {
    const result = run("refs", { quotes: [{ quote: 'the "golden pavilion"   opens at 9 am - 5 pm daily.', tab: "t1" }] });
    expect(result.kind === "quotes" && result.quotes).toHaveLength(1);
    expect(normalizeForMatch("The “Golden”  Pavilion — 9–5")).toBe(normalizeForMatch('the "golden" pavilion - 9-5'));
  });

  it("drops a fabricated quote, a quote cited to the wrong tab, an unknown tab, and one that is too short or too long, and says how many", () => {
    const result = run("refs", {
      quotes: [
        { quote: "Kyoto is best in autumn.", tab: "t1" },
        { quote: "Kyoto sells the best matcha in Japan.", tab: "t1" }, // fabricated
        { quote: "Go early to avoid crowds.", tab: "t1" }, // real, but from t2
        { quote: "Go early to avoid crowds.", tab: "t9" }, // unknown tab
        { quote: "Kyoto", tab: "t1" }, // too short
        { quote: "Thousands of torii gates climb the hill. ".repeat(20), tab: "t2" }, // too long
      ],
    });
    if (result.kind !== "quotes") throw new Error("expected quotes");
    expect(result.quotes).toHaveLength(1);
    expect(result.note).toBe("5 quotes could not be verified and were left out.");
  });

  it("keeps at most 10 quotes and never repeats one", () => {
    const material = Array.from({ length: 14 }, (_, i) => `Sentence number ${i} is quotable.`).join(" ");
    const tabs: MaterialTab[] = [{ id: "t1", title: "T", url: "https://c.example/x", material }];
    const answer = { quotes: Array.from({ length: 14 }, (_, i) => ({ quote: `Sentence number ${i} is quotable.`, tab: "t1" })).concat([{ quote: "Sentence number 0 is quotable.", tab: "t1" }]) };
    const result = validateAnswer(agent("refs"), answer, tabs);
    expect(result.kind === "quotes" && result.quotes).toHaveLength(10);
  });

  it("zero surviving quotes is a success with an empty list and a plain note", () => {
    const result = run("refs", { quotes: [{ quote: "Completely made up sentence here.", tab: "t1" }] });
    expect(result).toEqual({ kind: "quotes", quotes: [], note: "1 quote could not be verified and was left out." });
    const none = run("refs", { quotes: [] });
    expect(none.kind === "quotes" && none.quotes).toEqual([]);
    expect(none.kind === "quotes" && none.note).toMatch(/no quotable/i);
  });

  it("the title counts as material", () => {
    const result = run("refs", { quotes: [{ quote: "Fushimi Inari", tab: "t2" }] });
    expect(result.kind === "quotes" && result.quotes).toHaveLength(1);
  });
});
