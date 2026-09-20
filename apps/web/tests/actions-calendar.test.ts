// Google Calendar (owner only): create one event for the owner alone, and look at the calendar once without it ever
// being stored or shown to the AI. (spec FR-049 to FR-052, SC-014, SC-017, SC-018)
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reset } from "./helpers";
import {
  ScriptedActionModel,
  getActions,
  installFakeActionModel,
  makeWorkspace,
  postRun,
  postSuggest,
  putTabsIn,
  restoreActionModel,
  runAndWait,
  scriptedConnector,
  userIdOf,
} from "./actions-helpers";
import { CALENDAR_BINDINGS } from "@/src/actions/integrations/bindings/calendar";
import { eventFromArgs, EventInputError, listWindow } from "@/src/actions/integrations/calendar-time";
import { connectionStatus, resetIntegrationHealthForTests } from "@/src/actions/integrations/config";
import { setConnectorForTests } from "@/src/actions/integrations/connector";
import { mcpConnector, resetMcpClientForTests } from "@/src/actions/integrations/mcp-client";
import type { ConnectorResult } from "@/src/actions/integrations/connector";

const ALICE = "alice-actions-calendar-aaaa";
const BOB = "bob-actions-calendar-bbbbbb";

const bindingOf = (toolId: string) => CALENDAR_BINDINGS.find((row) => row.toolId === toolId)!;

describe("an event has to be real, and is for the owner alone (FR-049, FR-050)", () => {
  const ok = (args: Record<string, unknown>) => eventFromArgs({ title: "Dentist", ...args });
  const bad = (args: Record<string, unknown>) => {
    try {
      eventFromArgs({ title: "Dentist", ...args });
    } catch (error) {
      expect(error).toBeInstanceOf(EventInputError);
      return (error as Error).message;
    }
    throw new Error("expected the event to be refused");
  };

  it("a day with no time is an all-day event; the end, when given, is the LAST day", () => {
    expect(ok({ start: "2026-10-03" })).toMatchObject({ allDay: true, start: "2026-10-03T00:00:00", end: "2026-10-04T00:00:00" });
    expect(ok({ start: "2026-10-03", end: "2026-10-05" })).toMatchObject({ allDay: true, start: "2026-10-03T00:00:00", end: "2026-10-06T00:00:00" });
  });

  it("a timed start with no end lasts one hour, across midnight and month ends too", () => {
    expect(ok({ start: "2026-10-03T09:30" })).toMatchObject({ allDay: false, start: "2026-10-03T09:30:00", end: "2026-10-03T10:30:00" });
    expect(ok({ start: "2026-10-31T23:30" }).end).toBe("2026-11-01T00:30:00");
    expect(ok({ start: "2028-02-28T23:45" }).end).toBe("2028-02-29T00:45:00"); // a leap year
  });

  it("keeps a time zone the start carries, and never invents one", () => {
    expect(ok({ start: "2026-10-03T09:30:00Z" }).end).toBe("2026-10-03T10:30:00Z");
    expect(ok({ start: "2026-10-03T09:30:00-04:00", end: "2026-10-03T11:00:00-04:00" })).toMatchObject({ start: "2026-10-03T09:30:00-04:00", end: "2026-10-03T11:00:00-04:00" });
    expect(ok({ start: "2026-10-03T09:30" }).start).not.toMatch(/Z|[+-]\d\d:\d\d$/); // the calendar's own zone
  });

  it("a start in the past is allowed (the button shows it first)", () => {
    expect(ok({ start: "2001-01-01T09:00" }).title).toBe("Dentist");
  });

  it("refuses a missing title", () => {
    expect(() => eventFromArgs({ start: "2026-10-03" })).toThrow(EventInputError);
    expect(() => eventFromArgs({ title: "   ", start: "2026-10-03" })).toThrow(EventInputError);
  });

  it("refuses a day or time that is not real, and says which field", () => {
    for (const start of ["2026-02-30", "2026-13-01", "2026-10-03T25:00", "2026-10-03T09:75", "tomorrow", "03/10/2026", "2026-10-03 09:30", "2026-10-3", ""]) {
      expect(bad({ start }), start).toMatch(/"start"/);
    }
    expect(bad({ start: "2026-10-03T09:00", end: "2026-02-30T10:00" })).toMatch(/"end"/);
  });

  it("refuses an end that is not after the start", () => {
    expect(bad({ start: "2026-10-03T10:00", end: "2026-10-03T09:00" })).toMatch(/after/);
    expect(bad({ start: "2026-10-03T10:00", end: "2026-10-03T10:00" })).toMatch(/after/);
    expect(bad({ start: "2026-10-05", end: "2026-10-03" })).toMatch(/after/);
    // the same wall-clock times are compared in their own zones
    expect(() => ok({ start: "2026-10-03T10:00:00+02:00", end: "2026-10-03T09:30:00Z" })).not.toThrow(); // 08:00Z to 09:30Z
    expect(bad({ start: "2026-10-03T10:00:00Z", end: "2026-10-03T11:00:00+02:00" })).toMatch(/after/); // 10:00Z to 09:00Z
  });

  it("refuses a start and an end on different forms", () => {
    expect(bad({ start: "2026-10-03", end: "2026-10-03T10:00" })).toMatch(/both/);
    expect(bad({ start: "2026-10-03T09:00Z", end: "2026-10-03T10:00" })).toMatch(/same time format/);
  });

  it("never echoes a value into its message", () => {
    expect(bad({ start: "SECRET-VALUE" })).not.toContain("SECRET-VALUE");
  });

  it("a look-up window is a week from the chosen day, or from today", () => {
    expect(listWindow("2026-10-03", 7)).toEqual({ start: "2026-10-03T00:00:00Z", end: "2026-10-10T00:00:00Z" });
    expect(listWindow(undefined, 7, new Date("2026-12-28T15:00:00Z"))).toEqual({ start: "2026-12-28T00:00:00Z", end: "2027-01-04T00:00:00Z" });
    expect(() => listWindow("2026-02-30", 7)).toThrow(EventInputError);
  });
});

describe("what is sent to Google", () => {
  it("create_event: no guests, no notifications, no calendar chosen, nothing recurring", () => {
    const sent = bindingOf("calendar_create_event").toArguments(
      { title: "Dentist", start: "2026-10-03T09:30", notes: "bring forms", location: "Main St", attendees: [{ email: "x@y.com" }], calendarId: "other@example.com", addGoogleMeetUrl: true, recurrenceData: ["RRULE:FREQ=DAILY"] },
      "primary calendar",
    );
    expect(sent).toEqual({
      summary: "Dentist",
      startTime: "2026-10-03T09:30:00",
      endTime: "2026-10-03T10:30:00",
      allDay: false,
      notificationLevel: "NONE",
      description: "bring forms",
      location: "Main St",
    });
    for (const forbidden of ["attendees", "attendeeEmails", "calendarId", "addGoogleMeetUrl", "googleMeetUrl", "recurrenceData", "guestPermissions", "attachments"]) {
      expect(sent, forbidden).not.toHaveProperty(forbidden);
    }
  });

  it("list_events: a bounded window in start order, nothing else", () => {
    expect(bindingOf("calendar_list_events").toArguments({ day: "2026-10-03" }, "")).toEqual({
      startTime: "2026-10-03T00:00:00Z",
      endTime: "2026-10-10T00:00:00Z",
      pageSize: 10,
      orderBy: "startTime",
    });
  });
});

describe("Calendar through the routes", () => {
  const KEYS = ["INTEGRATION_OWNER_USER_ID", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "MCP_GOOGLE_CALENDAR_URL", "MCP_GOOGLE_CALENDAR_COMMAND"];
  const saved: Record<string, string | undefined> = {};

  async function setup(options: { google?: boolean } = {}) {
    await reset();
    for (const key of KEYS) saved[key] = process.env[key];
    process.env.INTEGRATION_OWNER_USER_ID = await userIdOf(ALICE);
    if (options.google !== false) {
      process.env.GOOGLE_CLIENT_ID = "id";
      process.env.GOOGLE_CLIENT_SECRET = "secret";
      process.env.GOOGLE_REFRESH_TOKEN = "refresh";
    } else {
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;
      delete process.env.GOOGLE_REFRESH_TOKEN;
    }
    delete process.env.MCP_GOOGLE_CALENDAR_URL;
    delete process.env.MCP_GOOGLE_CALENDAR_COMMAND;
    resetIntegrationHealthForTests();
  }
  afterEach(() => {
    restoreActionModel();
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  function fakeCalendar(extra: Partial<ConnectorResult> = {}) {
    const base = scriptedConnector({ calendar_create_event: { text: "ok", links: [{ label: "Dentist", url: "https://www.google.com/calendar/event?eid=evt_123", id: "evt_123" }] } });
    const connector = {
      ...base,
      async call(toolId: string, args: Record<string, unknown>, signal?: AbortSignal) {
        if (toolId === "calendar_list_events") {
          base.calls.push({ toolId, args });
          return { text: "ok", links: [], events: [{ title: "Dentist SECRET-EVENT-TITLE", start: "2026-10-03T09:30:00-04:00", end: "2026-10-03T10:00:00-04:00", allDay: false }], ...extra };
        }
        return base.call(toolId, args, signal);
      },
    };
    setConnectorForTests(connector);
    return connector;
  }

  async function workspace(token = ALICE) {
    const ws = await makeWorkspace(token, "kyoto trip");
    await putTabsIn(token, ws.id, [{ url: "https://example.com/a", title: "A", snippet: "s" }]);
    return ws;
  }

  it("the owner creates exactly one event, and the run shows its link (SC-018)", async () => {
    await setup();
    installFakeActionModel(new ScriptedActionModel());
    const connector = fakeCalendar();
    const ws = await workspace();
    let started: { status: number };
    await runAndWait(async () => {
      started = await postRun(ALICE, ws.id, "calendar_create_event", { args: { title: "Dentist", start: "2026-10-03T09:30" }, label: "Add to my calendar" });
    });
    expect(started!.status).toBe(202);
    const run = (await getActions(ALICE, ws.id)).json.runs.find((r: { toolId: string }) => r.toolId === "calendar_create_event");
    expect(run.state).toBe("succeeded");
    expect(run.output.result).toEqual({ kind: "created", service: "calendar", what: "event" });
    expect(run.output.links[0]).toMatchObject({ url: "https://www.google.com/calendar/event?eid=evt_123", id: "evt_123" });
    const calls = connector.calls.filter((c) => c.toolId === "calendar_create_event");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({ summary: "Dentist", startTime: "2026-10-03T09:30:00", endTime: "2026-10-03T10:30:00", notificationLevel: "NONE" });
    expect(calls[0].args).not.toHaveProperty("attendees");
  }, 30_000);

  it("a bad title or time is refused at the click: nothing stored, nothing sent (FR-050)", async () => {
    await setup();
    installFakeActionModel(new ScriptedActionModel());
    const connector = fakeCalendar();
    const ws = await workspace();
    const cases: Record<string, unknown>[] = [
      { start: "2026-10-03T09:30" }, // no title
      { title: "Dentist" }, // no start
      { title: "Dentist", start: "2026-02-30" },
      { title: "Dentist", start: "2026-10-03T10:00", end: "2026-10-03T09:00" },
      { title: "Dentist", start: "2026-10-03", end: "2026-10-03T10:00" },
    ];
    for (const args of cases) {
      const refused = await postRun(ALICE, ws.id, "calendar_create_event", { args, label: "Add" });
      expect(refused.status, JSON.stringify(args)).toBe(400);
      expect(refused.json.code).toBe("bad_input");
    }
    expect(connector.calls).toHaveLength(0);
    expect((await getActions(ALICE, ws.id)).json.runs).toEqual([]);
  }, 30_000);

  it("nobody but the owner can use it, whether or not Google is connected (SC-014)", async () => {
    await setup();
    installFakeActionModel(new ScriptedActionModel());
    const connector = fakeCalendar();
    const ws = await makeWorkspace(BOB, "bob's");
    await putTabsIn(BOB, ws.id, [{ url: "https://example.com/b", title: "B", snippet: "s" }]);
    for (const [tool, args] of [
      ["calendar_create_event", { title: "x", start: "2026-10-03" }],
      ["calendar_list_events", {}],
    ] as const) {
      const refused = await postRun(BOB, ws.id, tool, { args, label: "x" });
      expect(refused.status, tool).toBe(403);
      expect(refused.json.code).toBe("not_available");
    }
    expect(connector.calls).toHaveLength(0);
    // ... and it is never even suggested to them
    const model = new ScriptedActionModel({ suggest: [{ suggestions: [] }] });
    installFakeActionModel(model);
    fakeCalendar();
    await postSuggest(BOB, ws.id);
    expect(model.calls[0].prompt).not.toContain("calendar_");
  }, 30_000);

  it("with no Google credentials the owner gets a plain 'connect Google' and nothing is stored", async () => {
    await setup({ google: false });
    installFakeActionModel(new ScriptedActionModel());
    fakeCalendar();
    const ws = await workspace();
    expect(connectionStatus("calendar")).toBe("missing");
    const refused = await postRun(ALICE, ws.id, "calendar_create_event", { args: { title: "x", start: "2026-10-03" }, label: "x" });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("not_connected");
    expect(refused.json.error).toMatch(/Connect Google/);
    expect((await getActions(ALICE, ws.id)).json.runs).toEqual([]);
  }, 30_000);

  it("the look-up is shown once in the click's response and is never stored (FR-051)", async () => {
    await setup();
    installFakeActionModel(new ScriptedActionModel());
    const connector = fakeCalendar();
    const ws = await workspace();
    const answered = await postRun(ALICE, ws.id, "calendar_list_events", { args: { day: "2026-10-03" }, label: "What's on my calendar" });
    expect(answered.status).toBe(200);
    expect(answered.json.calendar.events).toEqual([
      { title: "Dentist SECRET-EVENT-TITLE", start: "2026-10-03T09:30:00-04:00", end: "2026-10-03T10:00:00-04:00", allDay: false },
    ]);
    expect(answered.json.run.state).toBe("succeeded");
    expect(connector.calls[0].args).toMatchObject({ startTime: "2026-10-03T00:00:00Z", endTime: "2026-10-10T00:00:00Z" });

    // after a reload the run says how many were shown, and nothing else
    const listed = await getActions(ALICE, ws.id);
    const run = listed.json.runs.find((r: { toolId: string }) => r.toolId === "calendar_list_events");
    expect(run.output.result).toEqual({ kind: "calendar_events", shown: 1 });
    expect(run.output.links).toEqual([]);
    expect(JSON.stringify(listed.json)).not.toContain("SECRET-EVENT-TITLE");
  }, 30_000);

  it("a look-up shows at most five events", async () => {
    await setup();
    installFakeActionModel(new ScriptedActionModel());
    const many = Array.from({ length: 9 }, (_, i) => ({ title: `Event ${i}`, start: "2026-10-03T09:00:00Z", end: "2026-10-03T10:00:00Z", allDay: false }));
    fakeCalendar({ events: many });
    const ws = await workspace();
    const answered = await postRun(ALICE, ws.id, "calendar_list_events", { args: {}, label: "x" });
    expect(answered.json.calendar.events).toHaveLength(5);
  }, 30_000);

  it("what is on the calendar never reaches the AI: not in a suggestion pass, not in a click loop (SC-017)", async () => {
    await setup();
    const model = new ScriptedActionModel({ suggest: [{ suggestions: [] }, { suggestions: [] }] });
    installFakeActionModel(model);
    fakeCalendar();
    const ws = await workspace();
    await postRun(ALICE, ws.id, "calendar_list_events", { args: {}, label: "x" });
    await postSuggest(ALICE, ws.id, { force: true });
    expect(model.calls.length).toBeGreaterThan(0);
    for (const call of model.calls) expect(call.prompt).not.toContain("SECRET-EVENT-TITLE");
    // the tool list the pass sees names the owner's tools (so it can suggest adding an event), but no event content
    expect(model.calls[0].prompt).toContain("calendar_create_event");
  }, 30_000);

  it("a click loop cannot call the look-up as a helper, even when the model asks", async () => {
    await setup();
    const model = new ScriptedActionModel({
      step: [
        { step: "call", tool: "calendar_list_events", argsJson: "{}", note: null },
        { step: "call", tool: "append_plan_items", argsJson: JSON.stringify({ items: ["one"] }), note: null },
      ],
    });
    installFakeActionModel(model);
    const connector = fakeCalendar();
    const ws = await workspace();
    await runAndWait(() => postRun(ALICE, ws.id, "append_plan_items", { args: {}, label: "Add steps" }));
    expect(connector.calls.filter((c) => c.toolId === "calendar_list_events")).toHaveLength(0);
    const run = (await getActions(ALICE, ws.id)).json.runs.find((r: { toolId: string }) => r.toolId === "append_plan_items");
    expect(run.output.refused.map((r: { tool: string }) => r.tool)).toContain("calendar_list_events");
    for (const call of model.calls) expect(call.prompt).not.toContain("SECRET-EVENT-TITLE");
  }, 30_000);

  it("suggests the button with what will be created shown on it, including that nobody is invited", async () => {
    await setup();
    const model = new ScriptedActionModel({
      suggest: [
        {
          suggestions: [
            { tool: "calendar_create_event", label: "Put the flight on my calendar", reason: "You saved a flight for Oct 3.", argsJson: JSON.stringify({ title: "Flight to Kyoto", start: "2026-10-03T09:30", end: "2026-10-03T21:00" }) },
            { tool: "calendar_create_event", label: "a second event", reason: "duplicate tool", argsJson: JSON.stringify({ title: "x", start: "2026-10-04" }) },
            { tool: "calendar_create_event", label: "bad", reason: "times in the wrong order are dropped", argsJson: JSON.stringify({ title: "y", start: "2026-10-03T10:00" }) },
          ],
        },
      ],
    });
    installFakeActionModel(model);
    fakeCalendar();
    const ws = await workspace();
    const reply = await postSuggest(ALICE, ws.id);
    const suggestion = reply.json.suggestions.find((s: { toolId: string }) => s.toolId === "calendar_create_event");
    expect(suggestion).toBeTruthy();
    expect(reply.json.suggestions.filter((s: { toolId: string }) => s.toolId === "calendar_create_event")).toHaveLength(1); // one per tool
    expect(suggestion.service).toBe("calendar");
    expect(suggestion.effect).toBe("external");
    expect(suggestion.preview).toEqual(
      expect.arrayContaining([
        { name: "title", value: "Flight to Kyoto" },
        { name: "start", value: "2026-10-03T09:30" },
        { name: "guests", value: "none (no invitations are sent)" },
      ]),
    );
  }, 30_000);
});

describe("Calendar through the real MCP client, against a server shaped like Google's", () => {
  const KEYS = ["MCP_GOOGLE_CALENDAR_COMMAND", "MCP_GOOGLE_CALENDAR_ARGS", "MCP_GOOGLE_CALENDAR_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"];
  const saved: Record<string, string | undefined> = {};
  const server = fileURLToPath(new URL("./fixtures/fake-calendar-mcp.mjs", import.meta.url));

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    process.env.MCP_GOOGLE_CALENDAR_URL = "";
    process.env.MCP_GOOGLE_CALENDAR_COMMAND = process.execPath;
    process.env.MCP_GOOGLE_CALENDAR_ARGS = JSON.stringify([server]);
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_REFRESH_TOKEN = "refresh";
    resetIntegrationHealthForTests();
    resetMcpClientForTests();
    setConnectorForTests(null);
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const call = (toolId: string, args: Record<string, unknown>) =>
    mcpConnector().call(toolId, bindingOf(toolId).toArguments(args, ""), AbortSignal.timeout(20_000));

  it("connects, resolves both tools, and an event comes back with its link and id", async () => {
    expect(connectionStatus("calendar")).toBe("connected");
    const answer = await call("calendar_create_event", { title: "Dentist", start: "2026-10-03T09:30", notes: "forms" });
    expect(answer.links).toEqual([{ label: "Dentist", url: "https://www.google.com/calendar/event?eid=evt_123", id: "evt_123" }]);
    const received = JSON.parse(answer.text).received;
    expect(received).toEqual({ summary: "Dentist", startTime: "2026-10-03T09:30:00", endTime: "2026-10-03T10:30:00", allDay: false, notificationLevel: "NONE", description: "forms" });
    expect(received).not.toHaveProperty("attendees");
  }, 30_000);

  it("an all-day event is sent as all-day, from midnight to midnight after the last day", async () => {
    const answer = await call("calendar_create_event", { title: "Rent", start: "2026-10-04", end: "2026-10-05" });
    expect(JSON.parse(answer.text).received).toMatchObject({ allDay: true, startTime: "2026-10-04T00:00:00", endTime: "2026-10-06T00:00:00" });
  }, 30_000);

  it("a look-up parses Google's answer into title, start, and end; and none of it lands in links, items, or text fields a run stores", async () => {
    const answer = await call("calendar_list_events", { day: "2026-10-03" });
    expect(answer.events).toEqual([
      { title: "Dentist SECRET-EVENT-TITLE", start: "2026-10-03T09:30:00-04:00", end: "2026-10-03T10:00:00-04:00", allDay: false },
      { title: "Rent due", start: "2026-10-04", end: "2026-10-05", allDay: true },
    ]);
    expect(answer.links).toEqual([]);
    expect(answer.items).toEqual([]);
  }, 30_000);

  it("a 401 from Google makes Calendar 'rejected' without touching Drive or Gmail", async () => {
    await expect(call("calendar_create_event", { title: "AUTH", start: "2026-10-03" })).rejects.toMatchObject({ code: "rejected_credentials" });
    expect(connectionStatus("calendar")).toBe("rejected");
    expect(connectionStatus("drive")).not.toBe("rejected");
    expect(connectionStatus("gmail")).not.toBe("rejected");
  }, 30_000);
});
