// Google's hosted MCP endpoints (Drive / Gmail / Calendar) sometimes answer tools/list with
// HTTP 403 while still returning a valid JSON-RPC result. The MCP Streamable HTTP client treats
// any non-2xx as failure, so we normalize those responses before the SDK sees them.

type JsonRpcish = { jsonrpc?: unknown; result?: unknown; error?: unknown };

function looksLikeOkRpc(body: string): boolean {
  try {
    const json: unknown = JSON.parse(body);
    const msgs: JsonRpcish[] = Array.isArray(json) ? json : [json as JsonRpcish];
    return msgs.length > 0 && msgs.every((msg) => msg && typeof msg === "object" && msg.jsonrpc != null && "result" in msg && !("error" in msg && msg.error != null));
  } catch {
    return false;
  }
}

/** fetch for Google MCP transports: rewrite spurious 403 + successful JSON-RPC bodies to 200. */
export async function googleMcpFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status !== 403) return response;
  const text = await response.text();
  if (!looksLikeOkRpc(text)) {
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  return new Response(text, { status: 200, statusText: "OK", headers: response.headers });
}
