// A tiny stdio MCP server shaped like @notionhq/notion-mcp-server: same tool names, and every result is ONE
// text part holding a JSON string (that is what the real server returns; verified live on 2026-09-20).
// Test-only. It echoes what it received (`received`) and the NAMES of its environment variables (`envKeys`)
// so tests can assert what the app sent and what the app let a child process see. Never prints a value.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const tool = (name) => ({ name, description: name, inputSchema: { type: "object", properties: {}, additionalProperties: true } });
const server = new Server({ name: "fake-notion", version: "0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ["API-post-page", "API-patch-block-children", "API-post-search"].map(tool),
}));

const ok = (body) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });
const fail = (status, code, message) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ object: "error", status, code, message }) }] });

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const envKeys = Object.keys(process.env).sort();
  const title = args?.properties?.title?.title?.[0]?.text?.content;
  if (title === "HANG") return new Promise(() => {});
  if (title === "BAD") return fail(400, "validation_error", "body.children[0].paragraph.rich_text[0].text.content.length should be ≤ 2000");
  if (title === "AUTH") return fail(401, "unauthorized", "API token is invalid.");
  if (title === "NOTSHARED") return fail(404, "object_not_found", "Could not find page. Make sure the relevant pages are shared with your integration.");
  if (name === "API-post-page") {
    return ok({
      object: "page",
      id: "11111111-2222-3333-4444-555555555555",
      url: "https://www.notion.so/Kyoto-summary-11111111222233334444555555555555",
      parent: args.parent,
      properties: { title: { id: "title", type: "title", title: [{ type: "text", plain_text: title, text: { content: title } }] } },
      received: args,
      envKeys,
    });
  }
  if (name === "API-patch-block-children") {
    return ok({ object: "list", results: (args.children ?? []).map((_, i) => ({ object: "block", id: `b${i}` })), received: args, envKeys });
  }
  if (name === "API-post-search") {
    return ok({
      object: "list",
      results: [
        { object: "page", id: "aaaaaaaa-0000-0000-0000-000000000001", url: "https://www.notion.so/Kyoto-ryokan-a1", properties: { title: { id: "title", type: "title", title: [{ type: "text", plain_text: "Kyoto ryokan shortlist" }] } } },
        { object: "page", id: "aaaaaaaa-0000-0000-0000-000000000002", url: "https://www.notion.so/Packing-a2", properties: { Name: { id: "title", type: "title", title: [{ type: "text", plain_text: "Packing list" }] } } },
      ],
      received: args,
      envKeys,
    });
  }
  return fail(404, "unknown_tool", "no such tool");
});

await server.connect(new StdioServerTransport());
