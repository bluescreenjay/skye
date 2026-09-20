import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as getProjects, POST as postProjects } from "@/app/api/projects/chat/route";
import { POST as postProposal } from "@/app/api/action-proposals/route";
import { POST as approveProposal } from "@/app/api/action-proposals/[id]/approve/route";
import { POST as cancelProposal } from "@/app/api/action-proposals/[id]/cancel/route";
import { POST as sendProposal } from "@/app/api/action-proposals/[id]/send/route";
import { POST as transcribe } from "@/app/api/voice/transcribe/route";
import { query } from "@/src/db";
import { setChatModelForTests } from "@/src/chat/model";
import { setConnectorForTests } from "@/src/actions/integrations/connector";
import { makeWorkspace, userIdOf } from "./chat-helpers";
import { read, req, reset } from "./helpers";

const ALICE = "project-assistant-alice-token";
const BOB = "project-assistant-bob-token";

beforeEach(async () => { await reset(); });
afterEach(() => { setChatModelForTests(null); setConnectorForTests(null); for (const name of ["MCP_NOTION_URL", "MCP_NOTION_TOKEN", "NOTION_PARENT_PAGE_ID", "INTEGRATION_OWNER_USER_ID", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "MCP_GOOGLE_GMAIL_URL"]) delete process.env[name]; });

describe("all-projects chat", () => {
  it("uses only the paired person's workspaces and stores a separate conversation", async () => {
    const a = await makeWorkspace(ALICE, "Kyoto research");
    await makeWorkspace(BOB, "Secret launch");
    const seen: string[] = [];
    setChatModelForTests({ async *stream(input) { seen.push(input.system); yield "Kyoto research is about travel."; } });
    const result = await read(postProjects(req("POST", "/api/projects/chat", ALICE, { message: "What are my projects?" })));
    expect(result.status).toBe(200);
    expect(result.json.assistantMessage.citations).toEqual([expect.objectContaining({ workspaceId: a.id })]);
    expect(result.json.assistantMessage.coverage).toMatchObject({ checked: 1, total: 1, omitted: 0 });
    expect(seen[0]).toContain("Kyoto research");
    expect(seen[0]).not.toContain("Secret launch");
    const history = await read(getProjects(req("GET", "/api/projects/chat", ALICE)));
    expect(history.json.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect((await query("SELECT count(*)::int AS total FROM messages")).rows[0].total).toBe(0);
    expect((await read(getProjects(req("GET", "/api/projects/chat", BOB)))).json.messages).toEqual([]);
  });

  it("requires an owned answer and a separate approval before a write", async () => {
    const userId = await userIdOf(ALICE);
    const sourceId = crypto.randomUUID();
    await query("INSERT INTO project_messages(id, user_id, role, content) VALUES ($1::uuid, $2::uuid, 'assistant', 'Trip summary')", [sourceId, userId]);
    const prepared = await read(postProposal(req("POST", "/api/action-proposals", ALICE, { request: "make a Notion page for that", sourceScope: "project", sourceId })));
    expect(prepared.status).toBe(201);
    expect(prepared.json.proposal).toMatchObject({ state: "proposed", toolId: "notion_create_page", body: "Trip summary" });
    const id = prepared.json.proposal.id;
    await userIdOf(BOB);
    const foreign = await read(approveProposal(req("POST", `/api/action-proposals/${id}/approve`, BOB, {}), { params: Promise.resolve({ id }) }));
    expect(foreign.status).toBe(404);
    const cancelled = await read(cancelProposal(req("POST", `/api/action-proposals/${id}/cancel`, ALICE), { params: Promise.resolve({ id }) }));
    expect(cancelled.json.proposal.state).toBe("cancelled");
    expect((await read(approveProposal(req("POST", `/api/action-proposals/${id}/approve`, ALICE, {}), { params: Promise.resolve({ id }) }))).status).toBe(409);
  });

  it("keeps voice optional and authenticates transcription", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const form = new FormData();
    form.set("audio", new File([new Uint8Array(150)], "voice.webm", { type: "audio/webm" }));
    const anonymous = await transcribe(new Request("http://localhost/api/voice/transcribe", { method: "POST", body: form }));
    expect(anonymous.status).toBe(401);
    await userIdOf(ALICE);
    const paired = await transcribe(new Request("http://localhost/api/voice/transcribe", { method: "POST", body: form, headers: { authorization: `Bearer ${ALICE}` } }));
    expect(paired.status).toBe(503);
  });

  it("creates a reviewed Notion page once and preserves the provider link", async () => {
    const userId = await userIdOf(ALICE);
    const sourceId = crypto.randomUUID();
    await query("INSERT INTO project_messages(id, user_id, role, content) VALUES ($1::uuid, $2::uuid, 'assistant', 'Reviewed answer')", [sourceId, userId]);
    process.env.MCP_NOTION_URL = "https://example.test/mcp";
    process.env.MCP_NOTION_TOKEN = "test-token";
    process.env.NOTION_PARENT_PAGE_ID = "test-parent";
    const calls: { toolId: string; args: Record<string, unknown> }[] = [];
    setConnectorForTests({ status: () => "connected", available: () => true, async call(toolId, args) { calls.push({ toolId, args }); return { text: "created", links: [{ label: "Notion page", url: "https://notion.so/page", id: "page-1" }] }; } });
    const prepared = await read(postProposal(req("POST", "/api/action-proposals", ALICE, { request: "make a Notion page for that", sourceScope: "project", sourceId })));
    expect(calls).toHaveLength(0);
    const id = prepared.json.proposal.id;
    const approved = await read(approveProposal(req("POST", `/api/action-proposals/${id}/approve`, ALICE, { title: "Trip notes", body: "Reviewed answer" }), { params: Promise.resolve({ id }) }));
    expect(approved.status).toBe(200);
    expect(approved.json.proposal.state).toBe("succeeded");
    expect(approved.json.proposal.result.links[0].url).toBe("https://notion.so/page");
    expect(calls).toHaveLength(1);
    expect(calls[0].toolId).toBe("notion_create_page");
    expect((await read(approveProposal(req("POST", `/api/action-proposals/${id}/approve`, ALICE, {}), { params: Promise.resolve({ id }) }))).status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it("requires a separate exact-message tap to send email once", async () => {
    const userId = await userIdOf(ALICE);
    const sourceId = crypto.randomUUID();
    await query("INSERT INTO project_messages(id, user_id, role, content) VALUES ($1::uuid, $2::uuid, 'assistant', 'Reviewed answer')", [sourceId, userId]);
    process.env.INTEGRATION_OWNER_USER_ID = userId;
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_REFRESH_TOKEN = "refresh";
    process.env.MCP_GOOGLE_GMAIL_URL = "https://example.test/gmail";
    const calls: Record<string, unknown>[] = [];
    setConnectorForTests({ status: () => "connected", available: () => true, async call(_toolId, args) { calls.push(args); return { text: "sent", links: [] }; } });
    const prepared = await read(postProposal(req("POST", "/api/action-proposals", ALICE, { request: "email me that", sourceScope: "project", sourceId })));
    const id = prepared.json.proposal.id;
    expect((await read(approveProposal(req("POST", `/api/action-proposals/${id}/approve`, ALICE, { title: "Trip", body: "Reviewed answer", recipient: "bad" }), { params: Promise.resolve({ id }) }))).status).toBe(400);
    const approved = await read(approveProposal(req("POST", `/api/action-proposals/${id}/approve`, ALICE, { title: "Trip", body: "Reviewed answer", recipient: "me@example.com" }), { params: Promise.resolve({ id }) }));
    expect(approved.json.proposal.state).toBe("ready_to_send");
    expect(calls).toHaveLength(0);
    const sent = await read(sendProposal(req("POST", `/api/action-proposals/${id}/send`, ALICE), { params: Promise.resolve({ id }) }));
    expect(sent.json.proposal.state).toBe("succeeded");
    expect(calls).toEqual([{ to: "me@example.com", subject: "Trip", body: "Reviewed answer" }]);
    expect((await read(sendProposal(req("POST", `/api/action-proposals/${id}/send`, ALICE), { params: Promise.resolve({ id }) }))).status).toBe(409);
    expect(calls).toHaveLength(1);
  });
});
