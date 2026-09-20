import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reset } from "./helpers";
import {
  ScriptedActionModel,
  installFakeActionModel,
  makeWorkspace,
  postCancel,
  postConfirm,
  postRun,
  putTabsIn,
  restoreActionModel,
  runAndWait,
  scriptedConnector,
  userIdOf,
} from "./actions-helpers";
import { setConnectorForTests } from "@/src/actions/integrations/connector";
import { upsertSummary } from "@/src/actions/notes";

const ALICE = "alice-actions-gmail-token-aa";

describe("gmail and drive", () => {
  beforeEach(async () => {
    await reset();
  });
  afterEach(restoreActionModel);

  it("prepares a send preview and confirms once", async () => {
    const userId = await userIdOf(ALICE);
    process.env.INTEGRATION_OWNER_USER_ID = userId;
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_REFRESH_TOKEN = "refresh";
    process.env.MCP_GOOGLE_GMAIL_URL = "https://example.com/gmail";
    installFakeActionModel(new ScriptedActionModel());
    const connector = scriptedConnector({
      gmail_send_message: { text: "sent", links: [{ label: "msg", url: "https://mail.google.com/x", id: "m1" }] },
    });
    setConnectorForTests({
      ...connector,
      available: () => true,
      status: () => "connected",
      async call(toolId, args, signal) {
        if (toolId === "gmail_search_messages") {
          connector.calls.push({ toolId, args });
          return { text: "ok", links: [], mail: [{ from: "a@b.com", subject: "Hi", date: "today", excerpt: "hello" }] };
        }
        return connector.call(toolId, args, signal);
      },
    });
    const ws = await makeWorkspace(ALICE, "kyoto");
    await putTabsIn(ALICE, ws.id, [{ url: "https://en.wikipedia.org/wiki/Kyoto", title: "Kyoto" }]);
    await upsertSummary(userId, ws.id, "A summary.", { coverage: { tabsTotal: 1, tabsIncluded: 1, pagesRead: 0 }, unreadable: 1 });
    const preview = await postRun(ALICE, ws.id, "gmail_send_message", {
      args: { subject: "Hello", body: "See the summary", to: "friend@example.com" },
      label: "Send",
    });
    await runAndWait(async () => undefined);
    expect(preview.status).toBe(202);
    const runId = preview.json.run.id;
    const listed = await (await import("./actions-helpers")).getActions(ALICE, ws.id);
    const ready = listed.json.runs.find((r: { toolId: string }) => r.toolId === "gmail_send_message");
    expect(ready.output.result.kind).toBe("email_preview");
    expect(connector.calls.some((c) => c.toolId === "gmail_send_message")).toBe(false);
    const sent = await postConfirm(ALICE, ws.id, ready.id, { to: "friend@example.com" });
    expect(sent.status).toBe(200);
    expect((await postConfirm(ALICE, ws.id, ready.id, { to: "friend@example.com" })).json.code).toBe("already_sent");
    expect((await postConfirm(ALICE, ws.id, ready.id, { to: "Name <friend@example.com>" })).status).toBe(400);
    void runId;
    delete process.env.INTEGRATION_OWNER_USER_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REFRESH_TOKEN;
    delete process.env.MCP_GOOGLE_GMAIL_URL;
  });
});
