import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GITHUB_BINDINGS } from "@/src/actions/integrations/bindings/github";
import { NOTION_BINDINGS } from "@/src/actions/integrations/bindings/notion";
import { connectionStatus, resetIntegrationHealthForTests } from "@/src/actions/integrations/config";
import { ConnectorError } from "@/src/actions/integrations/connector";
import { googleAccessToken, resetGoogleTokenForTests, setGoogleTokenFetchForTests } from "@/src/actions/integrations/google-token";
import { mcpConnector, resetMcpClientForTests } from "@/src/actions/integrations/mcp-client";

describe("mcp bindings", () => {
  it("always adds dest and never lets args override it", () => {
    const row = GITHUB_BINDINGS.find((item) => item.toolId === "github_create_issue")!;
    const mapped = row.toArguments({ title: "t", body: "b", owner: "evil", repo: "other" }, "ours/repo");
    expect(mapped.owner).toBe("ours");
    expect(mapped.repo).toBe("repo");
  });
});

const notionBinding = (toolId: string) => NOTION_BINDINGS.find((row) => row.toolId === toolId)!;

describe("notion binding arguments", () => {
  const richTexts = (mapped: Record<string, unknown>) =>
    (mapped.children as { paragraph: { rich_text: { text: { content: string } }[] } }[]).flatMap((block) => block.paragraph.rich_text.map((r) => r.text.content));

  it("never puts more than 2,000 characters in one rich_text (Notion rejects longer)", () => {
    const long = "word ".repeat(700).trim(); // 3,499 characters on ONE line
    const mapped = notionBinding("notion_create_page").toArguments({ title: "t", content: long }, "parent-id");
    const pieces = richTexts(mapped);
    expect(pieces.length).toBeGreaterThan(1);
    expect(Math.max(...pieces.map((p) => p.length))).toBeLessThanOrEqual(2000);
    expect(pieces.join(" ").replace(/\s+/g, " ")).toBe(long); // nothing silently cut
  });

  it("never sends more than 100 blocks in one request", () => {
    const many = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");
    const mapped = notionBinding("notion_append_blocks").toArguments({ page: "p", content: many }, "parent-id");
    expect((mapped.children as unknown[]).length).toBeLessThanOrEqual(100);
    expect(richTexts(mapped).join("\n")).toContain("line 249"); // nothing dropped
  });
});

// The real MCP client, over a real stdio child process, against a fake server that answers the way
// @notionhq/notion-mcp-server does (one text part holding a JSON string). Nothing here touches the network.
describe("mcp client against a stdio server shaped like Notion's", () => {
  const TOKEN = "ntn_SENTINEL_TOKEN_0123456789";
  const PARENT = "28a56d0e-01dc-41dc-9f87-39fbc01a2f11";
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["MCP_NOTION_COMMAND", "MCP_NOTION_ARGS", "MCP_NOTION_TOKEN", "NOTION_PARENT_PAGE_ID", "MCP_NOTION_URL"];
  const server = fileURLToPath(new URL("./fixtures/fake-notion-mcp.mjs", import.meta.url));

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    process.env.MCP_NOTION_URL = "";
    process.env.MCP_NOTION_COMMAND = process.execPath;
    process.env.MCP_NOTION_ARGS = JSON.stringify([server]);
    process.env.MCP_NOTION_TOKEN = TOKEN;
    process.env.NOTION_PARENT_PAGE_ID = PARENT;
    resetIntegrationHealthForTests();
    resetMcpClientForTests();
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const call = (toolId: string, args: Record<string, unknown>, signal: AbortSignal = AbortSignal.timeout(20_000)) => {
    const mapped = notionBinding(toolId).toArguments(args, PARENT);
    return mcpConnector().call(toolId, mapped, signal);
  };

  it("is connected, and a created page comes back with its link and its id (FR-016)", async () => {
    expect(connectionStatus("notion")).toBe("connected");
    const result = await call("notion_create_page", { title: "Kyoto summary", content: "line one\nline two" });
    expect(result.links).toHaveLength(1);
    expect(result.links[0].url).toBe("https://www.notion.so/Kyoto-summary-11111111222233334444555555555555");
    expect(result.links[0].id).toBe("11111111-2222-3333-4444-555555555555");
    expect(result.links[0].label).toBe("Kyoto summary");
  }, 30_000);

  it("writes under the configured parent and nowhere else", async () => {
    const result = await call("notion_create_page", { title: "T", content: "x", parent: { page_id: "evil" } });
    const received = JSON.parse(result.text).received;
    expect(received.parent).toEqual({ page_id: PARENT });
  }, 30_000);

  it("a search comes back as titled items with links, including a differently named title property", async () => {
    const result = await call("notion_search", { text: "kyoto" });
    expect(result.items?.map((item) => item.title)).toEqual(["Kyoto ryokan shortlist", "Packing list"]);
    expect(result.items?.[0].url).toBe("https://www.notion.so/Kyoto-ryokan-a1");
  }, 30_000);

  it("a bad request (a validation error from Notion) is a service error and does NOT disconnect Notion", async () => {
    await expect(call("notion_create_page", { title: "BAD", content: "x" })).rejects.toMatchObject({ code: "service_error" });
    expect(connectionStatus("notion")).toBe("connected");
    const again = await call("notion_create_page", { title: "fine", content: "x" }); // still usable right away
    expect(again.links).toHaveLength(1);
  }, 30_000);

  it("a page not shared with the integration is a service error, not a credential problem", async () => {
    await expect(call("notion_create_page", { title: "NOTSHARED", content: "x" })).rejects.toMatchObject({ code: "service_error" });
    expect(connectionStatus("notion")).toBe("connected");
  }, 30_000);

  it("a rejected token (401) is rejected_credentials and marks Notion rejected", async () => {
    await expect(call("notion_create_page", { title: "AUTH", content: "x" })).rejects.toMatchObject({ code: "rejected_credentials" });
    expect(connectionStatus("notion")).toBe("rejected");
  }, 30_000);

  it("gives the child process only what it needs: PATH and NOTION_TOKEN, no other secret or setting", async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://x";
    const result = await call("notion_create_page", { title: "env", content: "x" });
    const keys: string[] = JSON.parse(result.text).envKeys;
    expect(keys).toContain("NOTION_TOKEN");
    expect(keys).toContain("PATH");
    expect(keys).not.toContain("GITHUB_PERSONAL_ACCESS_TOKEN"); // a Notion process has no business with a GitHub variable
    expect(keys).not.toContain("DATABASE_URL");
    expect(keys).not.toContain("MCP_NOTION_TOKEN");
  }, 30_000);

  it("a call that never answers ends as timed_out when the run's signal aborts, and does not hang", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 700);
    const started = Date.now();
    await expect(call("notion_create_page", { title: "HANG", content: "x" }, controller.signal)).rejects.toMatchObject({ code: "timed_out" });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it("a server that never finishes starting ends as timed_out when the run's signal aborts", async () => {
    process.env.MCP_NOTION_COMMAND = process.execPath;
    process.env.MCP_NOTION_ARGS = JSON.stringify(["-e", "setInterval(() => {}, 1000)"]); // starts, never speaks MCP
    resetMcpClientForTests();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 700);
    const started = Date.now();
    await expect(call("notion_create_page", { title: "x", content: "x" }, controller.signal)).rejects.toMatchObject({ code: "timed_out" });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it("never puts the token in an error", async () => {
    for (const title of ["BAD", "AUTH", "NOTSHARED"]) {
      const error = (await call("notion_create_page", { title, content: "x" }).catch((e: unknown) => e)) as ConnectorError;
      expect(error).toBeInstanceOf(ConnectorError);
      expect(`${error.message} ${error.stack ?? ""}`).not.toContain(TOKEN);
    }
  }, 30_000);
});

describe("google token", () => {
  const KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "MCP_GOOGLE_DRIVE_URL", "DRIVE_FOLDER_ID"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret-SENTINEL";
    process.env.GOOGLE_REFRESH_TOKEN = "refresh-SENTINEL";
    process.env.MCP_GOOGLE_DRIVE_URL = "https://drive.example.test/mcp";
    process.env.DRIVE_FOLDER_ID = "folder";
    resetIntegrationHealthForTests();
    resetMcpClientForTests();
    resetGoogleTokenForTests();
  });
  afterEach(() => {
    setGoogleTokenFetchForTests(null);
    resetGoogleTokenForTests();
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("a rejected refresh token (Google answers 401 unauthorized_client) is rejected_credentials, not a generic service error", async () => {
    setGoogleTokenFetchForTests((async () => new Response(JSON.stringify({ error: "unauthorized_client" }), { status: 401 })) as typeof fetch);
    const error = (await mcpConnector().call("drive_upload_markdown", { name: "n" }, AbortSignal.timeout(5_000)).catch((e: unknown) => e)) as ConnectorError;
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.code).toBe("rejected_credentials");
    expect(connectionStatus("drive")).toBe("rejected");
    expect(connectionStatus("gmail")).toBe("rejected");
    expect(`${error.message} ${error.stack ?? ""}`).not.toMatch(/SENTINEL/);
  });

  it("an exchange that returns no access token is rejected_credentials too", async () => {
    setGoogleTokenFetchForTests((async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch);
    await expect(mcpConnector().call("drive_upload_markdown", { name: "n" }, AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: "rejected_credentials" });
  });

  it("caches a good token until shortly before it expires", async () => {
    let calls = 0;
    setGoogleTokenFetchForTests((async () => {
      calls += 1;
      return new Response(JSON.stringify({ access_token: "ya29.SENTINEL", expires_in: 3600 }), { status: 200 });
    }) as typeof fetch);
    expect(await googleAccessToken()).toBe("ya29.SENTINEL");
    expect(await googleAccessToken()).toBe("ya29.SENTINEL");
    expect(calls).toBe(1);
  });
});
