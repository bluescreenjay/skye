// The wire format of a streamed reply (specs/008-workspace-ai-chat/contracts/http.md):
// server-sent events, `event: <name>` then `data: <JSON>`, a blank line after each.
import type { ChatStreamEvent } from "@ai-browser/shared";
import { corsHeaders } from "../json";

export function encodeEvent(event: ChatStreamEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** No caching or buffering by a proxy, so each piece reaches the client as it is written. */
export function streamHeaders(): HeadersInit {
  return {
    ...corsHeaders(),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
  };
}
