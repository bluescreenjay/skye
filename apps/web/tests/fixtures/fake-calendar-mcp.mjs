// A tiny stdio MCP server shaped like Google's Calendar MCP server (tools `create_event` and `list_events`,
// argument and result field names from Google's tool reference). Test-only. Every result is ONE text part holding
// a JSON string, and create_event echoes what it received so tests can assert exactly what the app sent.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const tool = (name) => ({ name, description: name, inputSchema: { type: "object", properties: {}, additionalProperties: true } });
const server = new Server({ name: "fake-calendar", version: "0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ["create_event", "list_events"].map(tool) }));
const ok = (body) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  if (name === "create_event") {
    if (args.summary === "AUTH") return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: 401, message: "Request had invalid authentication credentials (unauthorized)" } }) }] };
    return ok({
      id: "evt_123",
      summary: args.summary,
      htmlLink: "https://www.google.com/calendar/event?eid=evt_123",
      start: args.allDay ? { date: String(args.startTime).slice(0, 10) } : { dateTime: args.startTime },
      end: args.allDay ? { date: String(args.endTime).slice(0, 10) } : { dateTime: args.endTime },
      received: args,
    });
  }
  if (name === "list_events") {
    return ok({
      summary: "owner@example.com",
      timeZone: "America/New_York",
      accessRole: "owner",
      events: [
        { id: "e1", summary: "Dentist SECRET-EVENT-TITLE", start: { dateTime: "2026-10-03T09:30:00-04:00" }, end: { dateTime: "2026-10-03T10:00:00-04:00" }, attendees: [{ email: "guest@example.com" }], htmlLink: "https://www.google.com/calendar/event?eid=e1" },
        { id: "e2", summary: "Rent due", start: { date: "2026-10-04" }, end: { date: "2026-10-05" } },
      ],
      received: args,
    });
  }
  return { isError: true, content: [{ type: "text", text: "no such tool" }] };
});
await server.connect(new StdioServerTransport());
