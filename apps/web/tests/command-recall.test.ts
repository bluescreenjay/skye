import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "@/src/db";
import * as m from "@/src/command/messages";
import { resolvePeriod } from "@/src/command/period";
import type { InterpretedPeriod } from "@/src/command/validate";
import { ans, dbSnapshot, ctxHome, installFakeCommandModel, makeWorkspace, person, restoreCommandModel, say, userIdOf } from "./command-helpers";
import { reset } from "./helpers";

const ALICE = "alice-device-token-0001";
const BOB = "bob-device-token-000002";

// Expected instants below were computed independently (Python zoneinfo), not with the code under test.
// 2026-09-20 is a Sunday.
const NOW = new Date("2026-09-20T15:00:00Z");
const p = (kind: InterpretedPeriod["kind"], over: Partial<InterpretedPeriod> = {}): InterpretedPeriod => ({ kind, date: null, weekday: null, ...over });
const range = (r: ReturnType<typeof resolvePeriod>) => {
  if ("future" in r) throw new Error("future");
  return [r.start.toISOString(), r.end.toISOString()];
};

describe("resolvePeriod: the person's own local days", () => {
  it("America/New_York (UTC-4 in September)", () => {
    const tz = "America/New_York";
    expect(range(resolvePeriod(p("today"), NOW, tz))).toEqual(["2026-09-20T04:00:00.000Z", "2026-09-21T04:00:00.000Z"]);
    expect(range(resolvePeriod(p("yesterday"), NOW, tz))).toEqual(["2026-09-19T04:00:00.000Z", "2026-09-20T04:00:00.000Z"]);
    expect(range(resolvePeriod(p("this_week"), NOW, tz))).toEqual(["2026-09-14T04:00:00.000Z", "2026-09-21T04:00:00.000Z"]); // Monday to Sunday
    expect(range(resolvePeriod(p("last_week"), NOW, tz))).toEqual(["2026-09-07T04:00:00.000Z", "2026-09-14T04:00:00.000Z"]);
    expect(range(resolvePeriod(p("last_7_days"), NOW, tz))).toEqual(["2026-09-14T04:00:00.000Z", "2026-09-21T04:00:00.000Z"]);
    expect(range(resolvePeriod(p("date", { date: "2026-09-03" }), NOW, tz))).toEqual(["2026-09-03T04:00:00.000Z", "2026-09-04T04:00:00.000Z"]);
  });

  it("Asia/Kolkata (UTC+5:30: a half-hour offset)", () => {
    const tz = "Asia/Kolkata";
    expect(range(resolvePeriod(p("yesterday"), NOW, tz))).toEqual(["2026-09-18T18:30:00.000Z", "2026-09-19T18:30:00.000Z"]);
    expect(range(resolvePeriod(p("last_week"), NOW, tz))).toEqual(["2026-09-06T18:30:00.000Z", "2026-09-13T18:30:00.000Z"]);
  });

  it("Pacific/Auckland (ahead of UTC: the local date is already tomorrow's UTC date)", () => {
    const tz = "Pacific/Auckland";
    // 15:00Z on Sunday the 20th is 03:00 on Monday the 21st in Auckland.
    expect(range(resolvePeriod(p("today"), NOW, tz))).toEqual(["2026-09-20T12:00:00.000Z", "2026-09-21T12:00:00.000Z"]);
    expect(range(resolvePeriod(p("yesterday"), NOW, tz))).toEqual(["2026-09-19T12:00:00.000Z", "2026-09-20T12:00:00.000Z"]);
  });

  it("the person's time zone decides which day it is", () => {
    const late = new Date("2026-09-20T02:30:00Z"); // still Saturday evening in New York, already Sunday in Kolkata
    expect(range(resolvePeriod(p("today"), late, "America/New_York"))[0]).toBe("2026-09-19T04:00:00.000Z");
    expect(range(resolvePeriod(p("today"), late, "Asia/Kolkata"))[0]).toBe("2026-09-19T18:30:00.000Z");
  });

  it("daylight saving: the spring day is 23 hours and the fall day is 25, the days around them are 24", () => {
    const hours = (day: string, now: string) => {
      const [start, end] = range(resolvePeriod(p("date", { date: day }), new Date(now), "America/New_York"));
      return (Date.parse(end) - Date.parse(start)) / 3_600_000;
    };
    expect(hours("2026-03-08", "2026-04-01T12:00:00Z")).toBe(23);
    expect(hours("2026-03-07", "2026-04-01T12:00:00Z")).toBe(24);
    expect(hours("2026-03-09", "2026-04-01T12:00:00Z")).toBe(24);
    expect(hours("2026-11-01", "2026-12-01T12:00:00Z")).toBe(25);
    expect(hours("2026-10-31", "2026-12-01T12:00:00Z")).toBe(24);
    expect(hours("2026-11-02", "2026-12-01T12:00:00Z")).toBe(24);
    // The start instants themselves (spring: midnight is still UTC-5; fall: midnight is still UTC-4).
    expect(range(resolvePeriod(p("date", { date: "2026-03-08" }), new Date("2026-04-01T12:00:00Z"), "America/New_York"))[0]).toBe("2026-03-08T05:00:00.000Z");
    expect(range(resolvePeriod(p("date", { date: "2026-11-01" }), new Date("2026-12-01T12:00:00Z"), "America/New_York"))[0]).toBe("2026-11-01T04:00:00.000Z");
    // Auckland's spring-forward is on 2026-09-27.
    expect(range(resolvePeriod(p("date", { date: "2026-09-27" }), new Date("2026-10-15T00:00:00Z"), "Pacific/Auckland"))).toEqual(["2026-09-26T12:00:00.000Z", "2026-09-27T11:00:00.000Z"]);
  });

  it("a weekday is the most recent such day strictly BEFORE today (a Sunday saying 'sunday' means last Sunday)", () => {
    const tz = "America/New_York";
    expect(range(resolvePeriod(p("weekday", { weekday: "tuesday" }), NOW, tz))).toEqual(["2026-09-15T04:00:00.000Z", "2026-09-16T04:00:00.000Z"]);
    expect(range(resolvePeriod(p("weekday", { weekday: "saturday" }), NOW, tz))).toEqual(["2026-09-19T04:00:00.000Z", "2026-09-20T04:00:00.000Z"]);
    expect(range(resolvePeriod(p("weekday", { weekday: "sunday" }), NOW, tz))).toEqual(["2026-09-13T04:00:00.000Z", "2026-09-14T04:00:00.000Z"]); // 7 days ago, not today
    expect(range(resolvePeriod(p("weekday", { weekday: "monday" }), NOW, tz))).toEqual(["2026-09-14T04:00:00.000Z", "2026-09-15T04:00:00.000Z"]);
  });

  it("a week that starts before today's Monday crosses months and years correctly", () => {
    const tz = "America/New_York";
    const jan = new Date("2027-01-01T15:00:00Z"); // a Friday
    expect(range(resolvePeriod(p("this_week"), jan, tz))).toEqual(["2026-12-28T05:00:00.000Z", "2027-01-04T05:00:00.000Z"]);
    expect(range(resolvePeriod(p("last_week"), jan, tz))).toEqual(["2026-12-21T05:00:00.000Z", "2026-12-28T05:00:00.000Z"]);
  });

  it("a day that has not happened yet is 'future'; today is not", () => {
    expect(resolvePeriod(p("date", { date: "2026-09-21" }), NOW, "America/New_York")).toEqual({ future: true });
    expect("future" in resolvePeriod(p("date", { date: "2026-09-20" }), NOW, "America/New_York")).toBe(false);
  });

  it("describes each period in plain words", () => {
    const label = (period: InterpretedPeriod) => {
      const r = resolvePeriod(period, NOW, "America/New_York");
      return "future" in r ? "" : r.label;
    };
    expect(label(p("today"))).toBe("today (Sunday, September 20)");
    expect(label(p("yesterday"))).toBe("yesterday (Saturday, September 19)");
    expect(label(p("this_week"))).toBe("this week (September 14 to 20)");
    expect(label(p("last_week"))).toBe("last week (September 7 to 13)");
    expect(label(p("last_7_days"))).toBe("the last 7 days (September 14 to 20)");
    expect(label(p("weekday", { weekday: "tuesday" }))).toBe("Tuesday, September 15");
    expect(label(p("date", { date: "2026-09-03" }))).toBe("Thursday, September 3");
  });
});

// ---------------------------------------------------------------------------------------------------
// The answer, over recorded activity
// ---------------------------------------------------------------------------------------------------
const insertEvent = (userId: string, time: string, type: string, url: string, title: string, workspaceId: string | null) =>
  query(
    `INSERT INTO tab_events (time, id, user_id, tab_ref_id, chrome_tab_id, url, title, workspace_id, event_type)
     VALUES ($1::timestamptz, gen_random_uuid(), $2::uuid, NULL, 1, $3, $4, $5::uuid, $6)`,
    [time, userId, url, title, workspaceId, type],
  );
const YESTERDAY = "2026-09-19T15:00:00Z"; // 11:00 on Saturday the 19th in New York
const at = (n: number) => new Date(Date.parse(YESTERDAY) + n * 60_000).toISOString();

beforeEach(async () => {
  await reset();
  await person(ALICE);
  await person(BOB);
  vi.useFakeTimers({ toFake: ["Date"] }); // only the clock: timers and I/O run for real
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  restoreCommandModel();
});

const recall = (period: InterpretedPeriod | null, text = "what was I working on yesterday?") => {
  installFakeCommandModel(ans("recall", { period }));
  return say(ALICE, text, ctxHome({ timeZone: "America/New_York" }));
};

describe("what was I working on", () => {
  it("lists the workspaces and tabs that were active, most active first, and changes nothing", async () => {
    const userId = await userIdOf(ALICE);
    const [hack, kyoto] = [await makeWorkspace(ALICE, "Hackathon"), await makeWorkspace(ALICE, "Kyoto trip")];
    const RULES = "https://hack.example/rules";
    const PRIZES = "https://hack.example/prizes";
    const FLIGHTS = "https://travel.example/flights";
    const HOTEL = "https://travel.example/hotel";
    for (let i = 0; i < 3; i += 1) await insertEvent(userId, at(i), "activated", RULES, "Hackathon rules", hack.id);
    await insertEvent(userId, at(4), "opened", RULES, "Hackathon rules", hack.id); // opened counts too: 4 visits
    for (let i = 0; i < 2; i += 1) await insertEvent(userId, at(10 + i), "activated", PRIZES, "Prizes", hack.id);
    for (let i = 0; i < 5; i += 1) await insertEvent(userId, at(20 + i), "activated", FLIGHTS, "Flights to Osaka", kyoto.id);
    for (let i = 0; i < 3; i += 1) await insertEvent(userId, at(30 + i), "activated", HOTEL, "Hotel in Kyoto", kyoto.id);
    await insertEvent(userId, at(40), "activated", "https://loose.example/x", "A loose page", null);

    const fake = installFakeCommandModel(ans("recall", { period: p("yesterday") }));
    const before = await dbSnapshot();
    const reply = await say(ALICE, "what was I working on yesterday?", ctxHome({ timeZone: "America/New_York" }));
    expect(reply.status).toBe(200);
    expect(reply.json.kind).toBe("recalled");
    expect(reply.json.understood).toBe("Looking at what you were working on yesterday (Saturday, September 19).");
    expect(reply.json.periodLabel).toBe("yesterday (Saturday, September 19)");
    expect(reply.json.workspaces).toEqual([
      { workspaceId: kyoto.id, name: "Kyoto trip", linkable: true, visits: 8, tabs: [{ title: "Flights to Osaka", url: FLIGHTS, visits: 5 }, { title: "Hotel in Kyoto", url: HOTEL, visits: 3 }] },
      { workspaceId: hack.id, name: "Hackathon", linkable: true, visits: 6, tabs: [{ title: "Hackathon rules", url: RULES, visits: 4 }, { title: "Prizes", url: PRIZES, visits: 2 }] },
      { workspaceId: null, name: "Other", linkable: false, visits: 1, tabs: [{ title: "A loose page", url: "https://loose.example/x", visits: 1 }] },
    ]);
    expect(fake.calls).toHaveLength(1); // no AI beyond understanding the question
    expect(await dbSnapshot()).toBe(before);
  });

  it("counts only opened and activated: not updated, closed, or reassigned, and not non-web addresses", async () => {
    const userId = await userIdOf(ALICE);
    const ws = await makeWorkspace(ALICE, "Hackathon");
    const URL_A = "https://hack.example/a";
    await insertEvent(userId, at(1), "activated", URL_A, "A", ws.id);
    for (const type of ["updated", "closed", "reassigned"]) for (let i = 0; i < 4; i += 1) await insertEvent(userId, at(10 + i), type, URL_A, "A", ws.id);
    await insertEvent(userId, at(20), "activated", "chrome-extension://abc/home.html", "Home", ws.id);
    await insertEvent(userId, at(21), "opened", "about:blank", "Blank", ws.id);
    const reply = await recall(p("yesterday"));
    expect(reply.json.workspaces).toHaveLength(1);
    expect(reply.json.workspaces[0]).toMatchObject({ visits: 1, tabs: [{ url: URL_A, visits: 1 }] });
  });

  it("the start of the local day is in, and the end is out (and a minute before the start is another day)", async () => {
    const userId = await userIdOf(ALICE);
    const ws = await makeWorkspace(ALICE, "Hackathon");
    await insertEvent(userId, "2026-09-19T04:00:00Z", "activated", "https://hack.example/start", "Start", ws.id); // exactly local midnight: in
    await insertEvent(userId, "2026-09-19T03:59:59Z", "activated", "https://hack.example/before", "Before", ws.id); // Friday night: out
    await insertEvent(userId, "2026-09-20T03:59:59Z", "activated", "https://hack.example/last", "Last second", ws.id); // in
    await insertEvent(userId, "2026-09-20T04:00:00Z", "activated", "https://hack.example/end", "End", ws.id); // exactly the next midnight: out
    const reply = await recall(p("yesterday"));
    expect(reply.json.workspaces[0].tabs.map((t: { title: string }) => t.title).sort()).toEqual(["Last second", "Start"]);
  });

  it("a day with no recorded activity says so plainly and does not guess", async () => {
    const userId = await userIdOf(ALICE);
    const ws = await makeWorkspace(ALICE, "Hackathon");
    await insertEvent(userId, "2026-09-15T15:00:00Z", "activated", "https://hack.example/a", "A", ws.id); // another day
    const reply = await recall(p("yesterday"));
    expect(reply.json).toEqual({ kind: "say", message: "Nothing was recorded for yesterday (Saturday, September 19).", help: null });
    expect((await recall(p("weekday", { weekday: "tuesday" }))).json.kind).toBe("recalled"); // and the other day is answered
  });

  it("answers exactly the period asked: last week, a weekday, a date", async () => {
    const userId = await userIdOf(ALICE);
    const ws = await makeWorkspace(ALICE, "Hackathon");
    await insertEvent(userId, "2026-09-09T15:00:00Z", "activated", "https://hack.example/lastweek", "Last week", ws.id); // Wed 9th
    await insertEvent(userId, "2026-09-15T15:00:00Z", "activated", "https://hack.example/tuesday", "Tuesday", ws.id);
    await insertEvent(userId, "2026-09-03T15:00:00Z", "activated", "https://hack.example/thursday", "Thursday", ws.id);
    const titles = async (period: InterpretedPeriod) => (await recall(period)).json.workspaces?.flatMap((w: { tabs: { title: string }[] }) => w.tabs.map((t) => t.title));
    expect(await titles(p("last_week"))).toEqual(["Last week"]);
    expect(await titles(p("weekday", { weekday: "tuesday" }))).toEqual(["Tuesday"]);
    expect(await titles(p("date", { date: "2026-09-03" }))).toEqual(["Thursday"]);
    expect(await titles(p("this_week"))).toEqual(["Tuesday"]); // Monday the 14th onward
    expect(await titles(p("last_7_days"))).toEqual(["Tuesday"]);
  });

  it("a future date, and no period at all, are said plainly", async () => {
    expect((await recall(p("date", { date: "2026-09-25" }))).json).toEqual({ kind: "say", message: m.FUTURE_DAY, help: null });
    expect((await recall(null)).json).toEqual({ kind: "say", message: m.NO_PERIOD, help: null });
  });

  it("an archived workspace is listed without a link, and one that no longer exists is left out", async () => {
    const userId = await userIdOf(ALICE);
    const [live, archived] = [await makeWorkspace(ALICE, "Live"), await makeWorkspace(ALICE, "Retired")];
    await query("UPDATE workspaces SET status = 'archived' WHERE id = $1", [archived.id]);
    await insertEvent(userId, at(1), "activated", "https://a.example/1", "Live tab", live.id);
    await insertEvent(userId, at(2), "activated", "https://a.example/2", "Retired tab", archived.id);
    await insertEvent(userId, at(3), "activated", "https://a.example/3", "Ghost tab", crypto.randomUUID()); // a workspace that is gone
    const reply = await recall(p("yesterday"));
    expect(reply.json.workspaces.map((w: { name: string; linkable: boolean }) => [w.name, w.linkable]).sort()).toEqual([["Live", true], ["Retired", false]]);
    expect(JSON.stringify(reply.json)).not.toContain("Ghost");
  });

  it("shows at most 5 workspaces (most active) and 3 tabs each, ties broken by the more recent", async () => {
    const userId = await userIdOf(ALICE);
    const many = [];
    for (let i = 1; i <= 7; i += 1) many.push(await makeWorkspace(ALICE, `Space ${i}`));
    for (const [i, ws] of many.entries()) for (let n = 0; n < i + 1; n += 1) await insertEvent(userId, at(i * 10 + n), "activated", `https://s${i}.example/only`, `Tab of ${i + 1}`, ws.id);
    const busy = many[6];
    for (let t = 0; t < 5; t += 1) for (let n = 0; n < 3; n += 1) await insertEvent(userId, at(100 + t * 10 + n), "activated", `https://busy.example/${t}`, `Busy ${t}`, busy.id);
    const reply = await recall(p("yesterday"));
    expect(reply.json.workspaces).toHaveLength(5);
    expect(reply.json.workspaces[0].name).toBe("Space 7");
    expect(reply.json.workspaces[0].tabs).toHaveLength(3);
    expect(reply.json.workspaces.map((w: { visits: number }) => w.visits)).toEqual([...reply.json.workspaces.map((w: { visits: number }) => w.visits)].sort((a: number, b: number) => b - a));
    // Most visits first ("Tab of 7" has 7); tabs with EQUAL visits, the more recent first (Busy 4 was visited last).
    expect(reply.json.workspaces[0].tabs.map((t: { title: string; visits: number }) => [t.title, t.visits])).toEqual([["Tab of 7", 7], ["Busy 4", 3], ["Busy 3", 3]]);
  });

  it("never shows another person's activity", async () => {
    const bobId = await userIdOf(BOB);
    const bobs = await makeWorkspace(BOB, "Bobs work");
    await insertEvent(bobId, at(1), "activated", "https://bob.example/x", "BOBS-SECRET-TAB", bobs.id);
    const reply = await recall(p("yesterday"));
    expect(reply.json.kind).toBe("say");
    expect(JSON.stringify(reply.json)).not.toContain("BOBS-SECRET");
  });
});
