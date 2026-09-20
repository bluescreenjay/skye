// MCP client: one SDK Client per integration on globalThis. tools/list is lazy.
import type { IntegrationId } from "@ai-browser/shared";
import { ALL_BINDINGS } from "./bindings";
import { ConnectorError, type ConnectorResult, type ToolConnector } from "./connector";
import { integrationConfig, markRejected, connectionStatus, type Transport } from "./config";
import { BINDING_CACHE_MS, SEARCH_ITEMS_MAX, SEARCH_SNIPPET_CHARS, TOOL_CALL_TIMEOUT_MS } from "../limits";
import { googleAccessToken } from "./google-token";

type BindingState = { names: Map<string, string>; checkedAt: number };

type Holder = typeof globalThis & {
  __aiBrowserMcpBindings?: Map<IntegrationId, BindingState>;
};

function bindingCache(): Map<IntegrationId, BindingState> {
  const holder = globalThis as Holder;
  return (holder.__aiBrowserMcpBindings ??= new Map());
}

export function resetMcpClientForTests(): void {
  delete (globalThis as Holder).__aiBrowserMcpBindings;
}

function parseResult(raw: unknown): ConnectorResult {
  const textBits: string[] = [];
  const links: ConnectorResult["links"] = [];
  const items: ConnectorResult["items"] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      textBits.push(value);
      return;
    }
    if (!value || typeof value !== "object") return;
    const rec = value as Record<string, unknown>;
    if (typeof rec.text === "string") textBits.push(rec.text);
    if (typeof rec.url === "string") links.push({ label: String(rec.title ?? rec.label ?? rec.url), url: rec.url, id: typeof rec.id === "string" ? rec.id : null });
    if (typeof rec.title === "string" && items && items.length < SEARCH_ITEMS_MAX) {
      items.push({ title: rec.title, url: typeof rec.url === "string" ? rec.url : null, snippet: String(rec.snippet ?? rec.text ?? "").slice(0, SEARCH_SNIPPET_CHARS) });
    }
    if (Array.isArray(rec.content)) rec.content.forEach(walk);
    if (Array.isArray(value)) (value as unknown[]).forEach(walk);
  };
  walk(raw);
  return { text: textBits.join("\n").slice(0, 4_000), links, items };
}

type Listed = { names: Map<string, string>; listed: string[] };

async function connectAndList(integration: IntegrationId): Promise<{ client: { close(): Promise<void>; callTool(args: { name: string; arguments?: Record<string, unknown> }): Promise<unknown> }; listed: Listed }> {
  const cfg = integrationConfig(integration);
  if (!cfg.transport || !cfg.credentialPresent || !cfg.destination) throw new ConnectorError("not_connected");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  let transport: unknown;
  if (cfg.transport.kind === "http") {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const headers: Record<string, string> = {};
    if (integration === "drive" || integration === "gmail") headers.Authorization = `Bearer ${await googleAccessToken()}`;
    else {
      const token = process.env[`MCP_${integration.toUpperCase()}_TOKEN`];
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    transport = new StreamableHTTPClientTransport(new URL(cfg.transport.url), { requestInit: { headers } });
  } else {
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
    const token = process.env[`MCP_${integration.toUpperCase()}_TOKEN`];
    if (token) env.GITHUB_PERSONAL_ACCESS_TOKEN = token;
    if (integration === "notion" && process.env.MCP_NOTION_TOKEN) env.NOTION_TOKEN = process.env.MCP_NOTION_TOKEN;
    transport = new StdioClientTransport({ command: cfg.transport.command, args: cfg.transport.args, env });
    void (cfg.transport as Transport);
  }
  const client = new Client({ name: "ai-browser", version: "010b" });
  await client.connect(transport as never);
  const listed = await client.listTools();
  const ours = ALL_BINDINGS.filter((row) => row.integration === integration);
  const names = new Map<string, string>();
  for (const row of ours) {
    const hit = row.candidates.find((candidate) => listed.tools.some((tool) => tool.name === candidate));
    if (hit) names.set(row.toolId, hit);
  }
  bindingCache().set(integration, { names, checkedAt: Date.now() });
  return { client, listed: { names, listed: listed.tools.map((tool) => tool.name) } };
}

function remapConnectError(integration: IntegrationId, error: unknown): never {
  if (error instanceof ConnectorError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (/401|403|unauthorized/i.test(message)) {
    markRejected(integration);
    throw new ConnectorError("rejected_credentials");
  }
  throw new ConnectorError("service_error");
}

/** tools/list only. Live probes use this so they never call a write tool or read mail. */
export async function probeIntegration(integration: IntegrationId): Promise<{ listed: string[]; resolved: { toolId: string; bound: string | null }[] }> {
  let client: { close(): Promise<void> } | undefined;
  try {
    const opened = await connectAndList(integration);
    client = opened.client;
    const ours = ALL_BINDINGS.filter((row) => row.integration === integration);
    return {
      listed: opened.listed.listed,
      resolved: ours.map((row) => ({ toolId: row.toolId, bound: opened.listed.names.get(row.toolId) ?? null })),
    };
  } catch (error) {
    remapConnectError(integration, error);
  } finally {
    await client?.close().catch(() => undefined);
  }
}

async function listAndCall(
  integration: IntegrationId,
  toolId: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ConnectorResult> {
  let client: { close(): Promise<void>; callTool(args: { name: string; arguments?: Record<string, unknown> }): Promise<unknown> } | undefined;
  try {
    const opened = await connectAndList(integration);
    client = opened.client;
    const bound = opened.listed.names.get(toolId);
    if (!bound) throw new ConnectorError("not_connected");
    const result = await Promise.race([
      client.callTool({ name: bound, arguments: args }),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new ConnectorError("timed_out")), TOOL_CALL_TIMEOUT_MS);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new ConnectorError("timed_out"));
        });
      }),
    ]);
    if ((result as { isError?: boolean }).isError) {
      markRejected(integration);
      throw new ConnectorError("rejected_credentials");
    }
    return parseResult(result);
  } catch (error) {
    remapConnectError(integration, error);
  } finally {
    await client?.close().catch(() => undefined);
  }
}

export function mcpConnector(): ToolConnector {
  return {
    status: (id) => connectionStatus(id),
    available(toolId: string) {
      const row = ALL_BINDINGS.find((item) => item.toolId === toolId);
      if (!row) return false;
      const cached = bindingCache().get(row.integration);
      if (cached && Date.now() - cached.checkedAt < BINDING_CACHE_MS) return cached.names.has(toolId);
      return integrationConfig(row.integration).transport !== null && integrationConfig(row.integration).credentialPresent;
    },
    call(toolId, args, signal) {
      const row = ALL_BINDINGS.find((item) => item.toolId === toolId);
      if (!row) return Promise.reject(new ConnectorError("not_connected"));
      return listAndCall(row.integration, toolId, args, signal);
    },
  };
}
