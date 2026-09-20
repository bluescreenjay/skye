import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { query } from "@/src/db";
import * as m from "@/src/command/messages";
import { gate, getAgents, installFakeAgentModel, pressAgent, restoreAgentModel, runAndWait, textAnswer } from "./agents-helpers";
import { ans, apply, ctxHome, ctxPage, dbSnapshot, installFakeCommandModel, makeWorkspace, person, putTabsIn, restoreCommandModel, say, seedTabs, wsId } from "./command-helpers";
import { reset } from "./helpers";

const ALICE = "alice-device-token-0001";
const BOB = "bob-device-token-000002";

const PAGES = [
  { url: "https://hack.example/rules", title: "Hackathon rules" },
  { url: "https://hack.example/prizes", title: "Hackathon prizes" },
];

beforeEach(async () => {
  await reset();
  await person(ALICE);
  await person(BOB);
});
afterEach(async () => {
  restoreCommandModel();
  await restoreAgentModel();
});

const runCount = async () => Number((await query<{ n: string }>("SELECT count(*) AS n FROM action_runs")).rows[0].n);

describe("run an agent by name", () => {
  it("interprets 'summarize hackathon' into one agent action, and starts nothing", async () => {
    const hack = await makeWorkspace(ALICE, "Hackathon");
    await putTabsIn(ALICE, hack.id, PAGES);
    const agentModel = installFakeAgentModel();
    const fake = installFakeCommandModel((input) => ans("agent", { agent: "summarize", subject: [wsId(input, "hackathon")], subjectNamed: true }));
    const before = await dbSnapshot();
    const reply = await say(ALICE, "summarize hackathon");
    expect(reply.json).toEqual({ kind: "action", understood: "Running summarize for Hackathon.", action: { type: "agent", workspaceId: hack.id, agentId: "summarize" } });
    expect(fake.calls).toHaveLength(1);
    expect(agentModel.calls).toHaveLength(0); // understanding the command runs no agent
    expect(await runCount()).toBe(0);
    expect(await dbSnapshot()).toBe(before);
  });

  it("names each of the five agents by its catalog name", async () => {
    const hack = await makeWorkspace(ALICE, "Hackathon");
    const expected: Record<string, string> = { summarize: "summarize", compare: "compare", missing: "what's missing", "next-steps": "next steps", refs: "collect refs" };
    for (const [id, name] of Object.entries(expected)) {
      installFakeCommandModel(ans("agent", { agent: id, subject: [] , thisWorkspace: true }));
      const reply = await say(ALICE, `${name} for this workspace`, ctxHome({ expandedWorkspaceIds: [hack.id] }));
      expect(reply.json).toMatchObject({ kind: "action", understood: `Running ${name} for Hackathon.`, action: { type: "agent", agentId: id } });
    }
  });

  it("is the Home card's own run path: the 010 route stores ONE run and the saved result is what the card reads", async () => {
    const hack = await makeWorkspace(ALICE, "Hackathon");
    await putTabsIn(ALICE, hack.id, PAGES);
    const agentModel = installFakeAgentModel(textAnswer("Two pages about a hackathon.", ["t1"]));
    installFakeCommandModel((input) => ans("agent", { agent: "summarize", subject: [wsId(input, "hackathon")], subjectNamed: true }));
    const action = (await say(ALICE, "summarize hackathon")).json.action;

    // The client presses exactly the route the card presses.
    const { pressed, agents } = await runAndWait(ALICE, action.workspaceId, action.agentId);
    expect(pressed.status).toBe(202);
    expect(await runCount()).toBe(1);
    expect(agentModel.calls).toHaveLength(1);
    const summarize = agents.json.agents.find((a: { id: string }) => a.id === "summarize");
    expect(summarize.latest.state).toBe("succeeded");
    expect(summarize.latest.output.result).toMatchObject({ kind: "text", text: "Two pages about a hackathon." });

    // The bar has no run path of its own: /apply refuses an agent action.
    const refused = await apply(ALICE, action);
    expect(refused.status).toBe(400);
    expect(await runCount()).toBe(1);
  });

  it("asks which when two workspaces match, with a resolved agent action per button, and starts nothing", async () => {
    const a = await makeWorkspace(ALICE, "Hackathon 2025");
    const b = await makeWorkspace(ALICE, "Hackathon 2026");
    installFakeCommandModel((input) => ans("agent", { agent: "summarize", subject: [wsId(input, "hackathon 2025"), wsId(input, "hackathon 2026")], subjectNamed: true }));
    const reply = await say(ALICE, "summarize hackathon");
    expect(reply.json.kind).toBe("ask");
    expect(reply.json.choices.map((c: { label: string }) => c.label)).toEqual(["Hackathon 2025", "Hackathon 2026"]);
    expect(reply.json.choices.map((c: { step: unknown }) => c.step)).toEqual([
      { kind: "action", action: { type: "agent", workspaceId: a.id, agentId: "summarize" } },
      { kind: "action", action: { type: "agent", workspaceId: b.id, agentId: "summarize" } },
    ]);
    expect(await runCount()).toBe(0);
  });

  it("says so, and lists the person's workspaces, when none matches", async () => {
    await makeWorkspace(ALICE, "Kyoto trip");
    await makeWorkspace(BOB, "Bobs Hackathon");
    installFakeCommandModel(ans("agent", { agent: "summarize", subject: ["w9"], subjectNamed: true }));
    const reply = await say(ALICE, "summarize hackathon");
    expect(reply.json).toEqual({ kind: "say", message: "I couldn't find a workspace like that. Yours are: Kyoto trip.", help: null });
    expect(await runCount()).toBe(0);
  });

  it("'this workspace' is the active tab's workspace on a page, and with no name it defaults to it", async () => {
    const hack = await makeWorkspace(ALICE, "Hackathon");
    const [first] = await putTabsIn(ALICE, hack.id, PAGES);
    const active = { chromeTabId: first.chromeTabId!, url: first.url };
    for (const over of [{ thisWorkspace: true }, { subjectNamed: false }]) {
      installFakeCommandModel(ans("agent", { agent: "next-steps", ...over }));
      const reply = await say(ALICE, "next steps for this workspace", ctxPage(active));
      expect(reply.json).toMatchObject({ kind: "action", action: { type: "agent", workspaceId: hack.id, agentId: "next-steps" } });
    }
  });

  it("on Home it is the single expanded card, and says why when there is none or several", async () => {
    const one = await makeWorkspace(ALICE, "Hackathon");
    const two = await makeWorkspace(ALICE, "Kyoto trip");
    installFakeCommandModel(ans("agent", { agent: "summarize", thisWorkspace: true }));
    expect((await say(ALICE, "summarize this workspace", ctxHome({ expandedWorkspaceIds: [one.id] }))).json.action.workspaceId).toBe(one.id);
    expect((await say(ALICE, "summarize this workspace", ctxHome())).json).toEqual({ kind: "say", message: m.CURRENT_NONE, help: null });
    expect((await say(ALICE, "summarize this workspace", ctxHome({ expandedWorkspaceIds: [one.id, two.id] }))).json).toEqual({ kind: "say", message: m.CURRENT_SEVERAL, help: null });
    expect(await runCount()).toBe(0);
  });

  it("on a page whose tab is in Other it asks: pick a workspace or make one", async () => {
    const hack = await makeWorkspace(ALICE, "Hackathon");
    const loose = (await seedTabs(ALICE, [{ url: "https://loose.example/a", title: "Loose page" }]))[0];
    installFakeCommandModel(ans("agent", { agent: "summarize", thisWorkspace: true }));
    const reply = await say(ALICE, "summarize this workspace", ctxPage({ chromeTabId: loose.chromeTabId!, url: loose.url }));
    expect(reply.json.kind).toBe("ask");
    expect(reply.json.question).toBe(m.CURRENT_OTHER_QUESTION);
    expect(reply.json.choices[0]).toMatchObject({ label: "Hackathon", step: { kind: "action", action: { type: "agent", workspaceId: hack.id } } });
    expect(reply.json.choices.at(-1)).toEqual({ label: "create a workspace for these tabs", step: { kind: "submit", text: "create a workspace for these tabs" } });
  });

  it("a page with a tab the server has never seen is also 'in no workspace'", async () => {
    await makeWorkspace(ALICE, "Hackathon");
    installFakeCommandModel(ans("agent", { agent: "summarize", thisWorkspace: true }));
    const reply = await say(ALICE, "summarize this workspace", ctxPage({ chromeTabId: 4242, url: "https://never-seen.example/" }));
    expect(reply.json.kind).toBe("ask");
  });

  it("a second press while the same agent is running is the route's own 409, and starts nothing new", async () => {
    const hack = await makeWorkspace(ALICE, "Hackathon");
    await putTabsIn(ALICE, hack.id, PAGES);
    const hold = gate();
    const agentModel = installFakeAgentModel(async () => {
      await hold.wait;
      return textAnswer("Done.");
    });
    expect((await pressAgent(ALICE, hack.id, "summarize")).status).toBe(202);
    const second = await pressAgent(ALICE, hack.id, "summarize");
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("run_in_progress");
    expect(await runCount()).toBe(1);
    hold.release();
    await runAndWait(ALICE, hack.id, "compare").catch(() => undefined);
    expect(agentModel.calls.filter((c) => c.agentId === "summarize")).toHaveLength(1);
  });

  it("a workspace with no web tabs gets the card's own refusal, and no AI request is made", async () => {
    const empty = await makeWorkspace(ALICE, "Empty");
    const agentModel = installFakeAgentModel();
    const refused = await pressAgent(ALICE, empty.id, "summarize");
    expect(refused.status).toBe(409);
    expect(refused.json).toEqual({ error: "Add some web tabs to this workspace first, then run an agent.", code: "no_tabs" });
    expect(agentModel.calls).toHaveLength(0);
    expect(await runCount()).toBe(0);
  });

  it("something that is not one of the five agents is refused plainly and starts nothing", async () => {
    await makeWorkspace(ALICE, "Hackathon");
    installFakeCommandModel((input) => ans("agent", { agent: "poem", subject: [wsId(input, "hackathon")], subjectNamed: true }));
    expect((await say(ALICE, "write me a poem about Kyoto")).json).toEqual({ kind: "say", message: m.CANT_DO, help: [...m.HELP] });
    installFakeCommandModel(ans("unsupported"));
    expect((await say(ALICE, "write me a poem about Kyoto")).json.kind).toBe("say");
    expect(await runCount()).toBe(0);
  });

  it("never lets an agent run for someone else's workspace", async () => {
    const bobs = await makeWorkspace(BOB, "Bobs Hackathon");
    installFakeAgentModel();
    expect((await pressAgent(ALICE, bobs.id, "summarize")).status).toBe(404);
    expect(await runCount()).toBe(0);
    expect((await getAgents(ALICE, bobs.id)).status).toBe(404);
  });
});
