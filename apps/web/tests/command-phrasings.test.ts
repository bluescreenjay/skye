// Offline coverage of the 45+ phrasings fixture: a fake interpreter returns the fixture's intent (with
// the fields each intent needs), and the real validator + resolver produce the expected reply kind.
// Ambiguous and unsupported entries must end in ask or say with the database unchanged. SC-002's floor
// (every intent, ≥6 ambiguous, ≥6 unsupported, compounds, page-content) is enforced on the fixture itself.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "@/src/db";
import {
  ans,
  ctxHome,
  dataOf,
  dbSnapshot,
  installFakeCommandModel,
  makeWorkspace,
  person,
  putTabsIn,
  restoreCommandModel,
  say,
  seedTabs,
  tabIds,
  userIdOf,
  wsId,
  type CommandScript,
} from "./command-helpers";
import { reset } from "./helpers";

/** Fixed clock so "yesterday" / "today" / "last week" match the seeded events (same day as recall tests). */
const NOW = new Date("2026-09-20T15:00:00Z");

const ALICE = "alice-phrasings-token01";

type Entry = {
  text: string;
  intent: string;
  expect: "action" | "navigate" | "found" | "recalled" | "say" | "ask";
  ambiguous?: boolean;
  unsupported?: boolean;
  note?: string;
};

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/command-phrasings.json", import.meta.url), "utf8")) as Entry[];

const AGENTS = ["summarize", "compare", "missing", "next-steps", "refs"] as const;

/** Build a raw model answer from the fixture entry and the material the server just put in the prompt. */
function scriptFor(entry: Entry): CommandScript {
  return (input) => {
    const data = dataOf(input);
    const over: Record<string, unknown> = {};

    if (entry.intent === "unsupported") {
      over.reason = entry.note === "page_content" || /page|article|booking|ryokan|say about|mention/i.test(entry.text) ? "page_content" : "not_supported";
    }
    if (entry.intent === "multiple") {
      // Verbatim pieces of the typed text (validator keeps only substrings).
      let parts: string[] =
        entry.text.includes("organize") && entry.text.includes("summarize")
          ? ["organize my tabs", "summarize Hackathon"]
          : entry.text.includes("create") && entry.text.includes("clean")
            ? ["create a workspace", "clean up"]
            : ["find my flight tab", "open Hackathon"];
      parts = parts.filter((p) => entry.text.toLowerCase().includes(p.toLowerCase()));
      if (parts.length === 0) parts = [entry.text.slice(0, 40)];
      over.parts = parts;
    }
    if (entry.intent === "clarify") {
      over.alternatives = ["organize", "cleanup"];
      over.confidence = 0.4;
    }
    if (entry.intent === "organize" || entry.intent === "cleanup" || entry.intent === "show" || entry.intent === "undo") {
      // defaults are enough
    }
    if (entry.intent === "group") {
      const ids = tabIds(input, "shopping", "camera", "nikon", "tripod", "lens");
      over.tabs = ids.slice(0, 3);
      over.name = "Shopping";
    }
    if (entry.intent === "move") {
      if (/other/i.test(entry.text)) {
        over.toOther = true;
        over.scope = "these_tabs";
      } else if (entry.ambiguous) {
        over.tabs = tabIds(input, "flight").slice(0, 2);
        over.destination = data.workspaces.filter((w) => /project alpha/i.test(w.name)).map((w) => w.id);
        over.destinationNamed = true;
      } else {
        over.tabs = tabIds(input, "flight", "ramen").slice(0, 2);
        over.destination = [wsId(input, entry.text.toLowerCase().includes("cooking") ? "Cooking" : "Kyoto trip")];
        over.destinationNamed = true;
      }
    }
    if (entry.intent === "rename") {
      if (entry.ambiguous) {
        over.subject = data.workspaces.filter((w) => /project alpha/i.test(w.name)).map((w) => w.id);
        over.subjectNamed = true;
      } else if (/shopping/i.test(entry.text)) {
        over.subject = [wsId(input, "Shopping")];
        over.subjectNamed = true;
      } else {
        over.thisWorkspace = true;
      }
      over.name = /japan/i.test(entry.text) ? "Japan 2026" : /errands/i.test(entry.text) ? "Errands" : "Beta";
    }
    if (entry.intent === "merge") {
      if (entry.ambiguous) {
        over.subject = data.workspaces.filter((w) => /project alpha/i.test(w.name)).map((w) => w.id);
        over.subjectNamed = true;
        over.destination = [wsId(input, "Errands")];
        over.destinationNamed = true;
      } else {
        over.subject = [wsId(input, "Shopping")];
        over.subjectNamed = true;
        over.destination = [wsId(input, "Errands")];
        over.destinationNamed = true;
      }
    }
    if (entry.intent === "create") {
      over.scope = "these_tabs";
      over.name = /weekend/i.test(entry.text) ? "Weekend plans" : /kyoto/i.test(entry.text) ? "Kyoto trip" : "Loose tabs";
      // "Kyoto trip" already exists → resolver asks to move instead; fixture marks expect action for the
      // generic create and ask only when we force a clash via note. Override expect path below in the test
      // by using a free name for the named-create paraphrase that would clash.
      if (/called kyoto/i.test(entry.text)) over.name = "Brand new trip";
    }
    if (entry.intent === "open_workspace") {
      if (entry.ambiguous) {
        over.subject = data.workspaces.filter((w) => /project alpha/i.test(w.name)).map((w) => w.id);
        over.subjectNamed = true;
      } else {
        const name = /cooking/i.test(entry.text) ? "Cooking" : "Hackathon";
        over.subject = [wsId(input, name)];
        over.subjectNamed = true;
      }
    }
    if (entry.intent === "find") {
      if (/workspace|ramen recipes/i.test(entry.text)) {
        over.workspaces = [wsId(input, "Cooking")];
      } else {
        over.tabs = tabIds(input, "flight", "rail", "ramen").slice(0, 3);
      }
    }
    if (entry.intent === "recall") {
      if (/yesterday/i.test(entry.text)) over.period = { kind: "yesterday", date: null, weekday: null };
      else if (/today/i.test(entry.text)) over.period = { kind: "today", date: null, weekday: null };
      else over.period = { kind: "this_week", date: null, weekday: null };
    }
    if (entry.intent === "agent") {
      const lower = entry.text.toLowerCase();
      over.agent = lower.includes("compare")
        ? "compare"
        : lower.includes("missing")
          ? "missing"
          : lower.includes("next")
            ? "next-steps"
            : lower.includes("reference") || lower.includes("refs") || lower.includes("save useful")
              ? "refs"
              : "summarize";
      if (/hackathon/i.test(entry.text)) {
        over.subject = [wsId(input, "Hackathon")];
        over.subjectNamed = true;
      } else if (/cooking/i.test(entry.text)) {
        over.subject = [wsId(input, "Cooking")];
        over.subjectNamed = true;
      } else {
        over.thisWorkspace = true;
      }
    }

    return ans(entry.intent, over);
  };
}

beforeEach(async () => {
  await reset();
  await person(ALICE);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  restoreCommandModel();
});

/** Seed one person with workspaces, loose tabs, activity, and two "Project Alpha" names for ambiguous cases. */
async function seedWorld() {
  const hackathon = await makeWorkspace(ALICE, "Hackathon");
  const cooking = await makeWorkspace(ALICE, "Cooking");
  const shopping = await makeWorkspace(ALICE, "Shopping");
  const errands = await makeWorkspace(ALICE, "Errands");
  const kyoto = await makeWorkspace(ALICE, "Kyoto trip");
  const alphaA = await makeWorkspace(ALICE, "Project Alpha A");
  const alphaB = await makeWorkspace(ALICE, "Project Alpha B");
  // Rename both to the same display name the person would type ("Project Alpha") by updating the DB:
  // two rows with the same name so FR-007 asks which.
  await query(`UPDATE workspaces SET name = 'Project Alpha' WHERE id = ANY($1::uuid[])`, [[alphaA.id, alphaB.id]]);

  await putTabsIn(ALICE, hackathon.id, [
    { url: "https://hack.example/rules", title: "Hackathon rules", snippet: "Submission deadline Friday" },
    { url: "https://hack.example/idea", title: "Project idea board", snippet: "Brainstorm notes" },
  ]);
  await putTabsIn(ALICE, cooking.id, [
    { url: "https://cook.example/ramen", title: "Best ramen recipe", snippet: "Tonkotsu broth" },
    { url: "https://cook.example/gyoza", title: "Pan-fried gyoza", snippet: "Pleated dumplings" },
  ]);
  await putTabsIn(ALICE, shopping.id, [{ url: "https://shop.example/cart", title: "Shopping cart", snippet: "3 items" }]);
  await putTabsIn(ALICE, kyoto.id, [
    { url: "https://airline.example/booking/osaka", title: "Flight booking: Osaka KIX", snippet: "NH 6" },
    { url: "https://rail.example/jr-pass", title: "Japan Rail Pass prices", snippet: "7 day pass" },
  ]);
  await seedTabs(ALICE, [
    { url: "https://shop.example/camera", title: "Nikon Z6 III review", snippet: "camera" },
    { url: "https://shop.example/tripod", title: "Best travel tripods", snippet: "tripod" },
    { url: "https://shop.example/lens", title: "50mm f1.8 lens deals", snippet: "lens" },
    { url: "https://loose.example/notes", title: "Loose notes", snippet: "scratch" },
  ]);

  const userId = await userIdOf(ALICE);
  // Activity for recall (opened/activated yesterday and today in America/New_York).
  const yesterday = "2026-09-19T15:00:00.000Z";
  const today = "2026-09-20T14:00:00.000Z";
  await query(
    `INSERT INTO tab_events (time, id, user_id, tab_ref_id, chrome_tab_id, url, title, workspace_id, event_type)
     VALUES
       ($2::timestamptz, gen_random_uuid(), $1::uuid, NULL, 101, 'https://hack.example/rules', 'Hackathon rules', $3::uuid, 'opened'),
       ($2::timestamptz, gen_random_uuid(), $1::uuid, NULL, 101, 'https://hack.example/rules', 'Hackathon rules', $3::uuid, 'activated'),
       ($2::timestamptz, gen_random_uuid(), $1::uuid, NULL, 102, 'https://cook.example/ramen', 'Best ramen recipe', $4::uuid, 'opened'),
       ($2::timestamptz, gen_random_uuid(), $1::uuid, NULL, 103, 'https://airline.example/booking/osaka', 'Flight booking: Osaka KIX', $5::uuid, 'activated'),
       ($6::timestamptz, gen_random_uuid(), $1::uuid, NULL, 101, 'https://hack.example/rules', 'Hackathon rules', $3::uuid, 'activated'),
       ($6::timestamptz, gen_random_uuid(), $1::uuid, NULL, 102, 'https://cook.example/ramen', 'Best ramen recipe', $4::uuid, 'opened')`,
    [userId, yesterday, hackathon.id, cooking.id, kyoto.id, today],
  );

  return { hackathon, cooking, shopping, errands, kyoto };
}

describe("command phrasings fixture (offline)", () => {
  it("covers every intent, ≥6 ambiguous, ≥6 unsupported, compounds, and page-content questions", () => {
    expect(FIXTURE.length).toBeGreaterThanOrEqual(45);
    const intents = new Set(FIXTURE.map((e) => e.intent));
    for (const intent of [
      "organize",
      "group",
      "move",
      "rename",
      "merge",
      "create",
      "cleanup",
      "show",
      "open_workspace",
      "find",
      "recall",
      "undo",
      "agent",
      "unsupported",
      "multiple",
      "clarify",
    ]) {
      expect(intents.has(intent), `missing intent ${intent}`).toBe(true);
    }
    // Each of the five agents appears in a note or text.
    for (const agent of AGENTS) {
      expect(
        FIXTURE.some((e) => e.intent === "agent" && (e.note?.includes(agent) || e.text.toLowerCase().includes(agent.replace("-", " ")))),
        `missing agent ${agent}`,
      ).toBe(true);
    }
    expect(FIXTURE.filter((e) => e.ambiguous).length).toBeGreaterThanOrEqual(6);
    expect(FIXTURE.filter((e) => e.unsupported).length).toBeGreaterThanOrEqual(6);
    expect(FIXTURE.filter((e) => e.intent === "multiple").length).toBeGreaterThanOrEqual(3);
    expect(FIXTURE.filter((e) => e.note === "page_content").length).toBeGreaterThanOrEqual(3);
  });

  it("every phrasing reaches the expected reply kind; ambiguous and unsupported change nothing", async () => {
    const { hackathon } = await seedWorld();
    const homeCtx = ctxHome({ expandedWorkspaceIds: [hackathon.id] });

    for (const entry of FIXTURE) {
      installFakeCommandModel(scriptFor(entry));
      const before = entry.ambiguous || entry.unsupported || entry.intent === "multiple" || entry.intent === "clarify" ? await dbSnapshot() : null;
      const reply = await say(ALICE, entry.text, homeCtx);
      expect(reply.status, `${entry.text}: ${JSON.stringify(reply.json)}`).toBe(200);
      expect(reply.json.kind, `${entry.text} (intent ${entry.intent})`).toBe(entry.expect);
      if (before !== null) {
        expect(await dbSnapshot(), `${entry.text} must not change the database`).toBe(before);
        expect(["ask", "say"]).toContain(reply.json.kind);
      }
    }
  });
});
