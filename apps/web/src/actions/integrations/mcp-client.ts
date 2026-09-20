// MCP client: a fresh SDK Client per call (a stdio server is a child process that is closed when the call ends).
// tools/list is checked on connect to resolve our fixed bindings. Nothing here logs, and no error text from a
// service, a tool, or a transport is ever copied into a ConnectorError (contracts/integrations.md).
import type { IntegrationId } from "@ai-browser/shared";
import { ALL_BINDINGS } from "./bindings";
import { ConnectorError, type ConnectorResult, type ToolConnector } from "./connector";
import { integrationConfig, markRejected, connectionStatus } from "./config";
import { BINDING_CACHE_MS, CONNECT_TIMEOUT_MS, SEARCH_ITEMS_MAX, SEARCH_SNIPPET_CHARS, TOOL_CALL_TIMEOUT_MS } from "../limits";
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

// ---------- reading what a server answered ----------

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);
const asId = (value: unknown): string | null => (typeof value === "string" && value ? value : typeof value === "number" ? String(value) : null);

/** Joins the plain_text of a rich-text array (Notion), or null when it is not one. */
function richText(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const text = value.map((part) => (isRec(part) && typeof part.plain_text === "string" ? part.plain_text : "")).join("");
  return text || null;
}

/** A human title for one result: a `title`/`name`/`summary`/`subject` string, a rich-text title, or a Notion title property. */
function titleOf(rec: Rec): string | null {
  for (const key of ["title", "name", "summary", "subject"]) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const direct = richText(rec.title);
  if (direct) return direct;
  if (isRec(rec.properties)) {
    for (const property of Object.values(rec.properties)) {
      if (isRec(property) && property.type === "title") {
        const text = richText(property.title);
        if (text) return text;
      }
    }
  }
  return null;
}

/** A web address on a result: `url`, GitHub's `html_url`, or Google Calendar's `htmlLink`. */
function urlOf(rec: Rec): string | null {
  for (const key of ["url", "html_url", "htmlLink"]) if (typeof rec[key] === "string") return rec[key] as string;
  return null;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** One calendar event as Google returns it: `summary`, and `start`/`end` holding a `dateTime` or an all-day `date`. */
function eventRow(entry: unknown): NonNullable<ConnectorResult["events"]>[number] | null {
  if (!isRec(entry)) return null;
  const start = isRec(entry.start) ? str(entry.start.dateTime) || str(entry.start.date) : str(entry.startTime);
  const end = isRec(entry.end) ? str(entry.end.dateTime) || str(entry.end.date) : str(entry.endTime);
  if (!start) return null;
  const allDay = isRec(entry.start) ? !entry.start.dateTime : false;
  return { title: str(entry.summary) || str(entry.title) || "(no title)", start, end, allDay };
}

/** One mail message. The field names are the common ones; a server that names them differently shows fewer fields. */
function mailRow(entry: unknown): NonNullable<ConnectorResult["mail"]>[number] | null {
  if (!isRec(entry)) return null;
  const from = str(entry.from) || str(entry.sender);
  const subject = str(entry.subject);
  if (!from && !subject) return null;
  return { from, subject, date: str(entry.date), excerpt: str(entry.snippet) || str(entry.excerpt) || str(entry.body) };
}

/** Servers answer with text parts; nearly all of them put a JSON document in the text. Parse what parses. */
function documentsOf(raw: unknown): { texts: string[]; docs: unknown[] } {
  const texts: string[] = [];
  const docs: unknown[] = [];
  const result = isRec(raw) ? raw : {};
  if (result.structuredContent !== undefined) docs.push(result.structuredContent);
  const parts = Array.isArray(result.content) ? result.content : [];
  for (const part of parts) {
    if (!isRec(part) || part.type !== "text" || typeof part.text !== "string") continue;
    texts.push(part.text);
    try {
      docs.push(JSON.parse(part.text));
    } catch {
      // plain text (for example "Issue created: https://…"): the URL fallback below handles it
    }
  }
  return { texts, docs };
}

const URL_IN_TEXT = /https:\/\/[^\s"'<>)\]]+/;

/**
 * What a tool call returned, reduced to what the product shows: a link for a created thing (its url and id),
 * or up to SEARCH_ITEMS_MAX titled items for a search. Everything here is untrusted text and is only ever
 * displayed as text (FR-040).
 */
export function parseResult(raw: unknown): ConnectorResult {
  const { texts, docs } = documentsOf(raw);
  const links: ConnectorResult["links"] = [];
  const items: NonNullable<ConnectorResult["items"]> = [];
  const events: NonNullable<ConnectorResult["events"]> = [];
  const mail: NonNullable<ConnectorResult["mail"]> = [];

  for (const doc of docs) {
    // Private lists (the owner's calendar, the owner's mail) go only into their own fields: never into `items`,
    // `links`, or anything a run stores. The caller shows them once and drops them.
    if (isRec(doc) && Array.isArray(doc.events)) {
      for (const entry of doc.events) {
        const row = eventRow(entry);
        if (row) events.push(row);
      }
      continue;
    }
    if (isRec(doc) && (Array.isArray(doc.messages) || Array.isArray(doc.threads))) {
      for (const entry of (doc.messages ?? doc.threads) as unknown[]) {
        const row = mailRow(entry);
        if (row) mail.push(row);
      }
      continue;
    }
    const list = Array.isArray(doc) ? doc : isRec(doc) ? (["results", "items", "issues", "values", "data"].map((k) => doc[k]).find(Array.isArray) as unknown[] | undefined) : undefined;
    if (list) {
      for (const entry of list) {
        if (!isRec(entry) || items.length >= SEARCH_ITEMS_MAX) continue;
        const url = urlOf(entry);
        const title = titleOf(entry) ?? url;
        if (!title) continue;
        const snippet = ["snippet", "text", "description", "body"].map((k) => entry[k]).find((v) => typeof v === "string") as string | undefined;
        items.push({ title, url, snippet: (snippet ?? "").slice(0, SEARCH_SNIPPET_CHARS) });
        if (url) links.push({ label: title, url, id: asId(entry.id) });
      }
    } else if (isRec(doc)) {
      const url = urlOf(doc);
      if (url) links.push({ label: titleOf(doc) ?? url, url, id: asId(doc.id) });
    }
  }

  if (links.length === 0 && events.length === 0 && mail.length === 0) {
    const found = texts.map((text) => URL_IN_TEXT.exec(text)?.[0]).find(Boolean);
    if (found) links.push({ label: found, url: found, id: null });
  }
  return { text: texts.join("\n").slice(0, 4_000), links, items, ...(events.length > 0 ? { events } : {}), ...(mail.length > 0 ? { mail } : {}) };
}

/** A tool answered `isError`. A rejected credential is the only case that disconnects the service; a bad request does not. */
const AUTH_FAILURE = /\b401\b|unauthori[sz]ed|invalid[_ ]?token|token is invalid|bad credentials|invalid_auth|not_authed|token_revoked/i;

function toolErrorText(raw: unknown): string {
  return documentsOf(raw).texts.join(" ");
}

// ---------- connecting ----------

type Opened = {
  client: { close(): Promise<void>; callTool(args: { name: string; arguments?: Record<string, unknown> }): Promise<unknown> };
  listed: { names: Map<string, string>; listed: string[] };
};

/** The variable a stdio server expects its token in. Only what that server needs; never another integration's name. */
const STDIO_TOKEN_ENV: Partial<Record<IntegrationId, string>> = {
  github: "GITHUB_PERSONAL_ACCESS_TOKEN",
  notion: "NOTION_TOKEN",
};

/** Rejects when `signal` aborts. Removes its listener when `settled` resolves, so nothing leaks. */
function aborted(signal: AbortSignal): { promise: Promise<never>; stop: () => void } {
  let onAbort = () => {};
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new ConnectorError("timed_out"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  promise.catch(() => undefined); // an unused rejection must not become an unhandled one
  return { promise, stop: () => signal.removeEventListener("abort", onAbort) };
}

async function connectAndList(integration: IntegrationId, signal: AbortSignal): Promise<Opened> {
  const cfg = integrationConfig(integration);
  if (!cfg.transport || !cfg.credentialPresent || !cfg.destination) throw new ConnectorError("not_connected");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  let transport: unknown;
  if (cfg.transport.kind === "http") {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const headers: Record<string, string> = {};
    if (integration === "drive" || integration === "gmail" || integration === "calendar") headers.Authorization = `Bearer ${await googleAccessToken()}`;
    else {
      const token = process.env[`MCP_${integration.toUpperCase()}_TOKEN`];
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    transport = new StreamableHTTPClientTransport(new URL(cfg.transport.url), { requestInit: { headers } });
  } else {
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    // A minimal environment: PATH plus this server's own token. Never the server's whole environment.
    const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
    const tokenName = STDIO_TOKEN_ENV[integration];
    const token = process.env[`MCP_${integration.toUpperCase()}_TOKEN`];
    if (tokenName && token) env[tokenName] = token;
    transport = new StdioClientTransport({ command: cfg.transport.command, args: cfg.transport.args, env });
  }
  const client = new Client({ name: "ai-browser", version: "010b" });

  // Starting a server and listing its tools is bounded, and a server that never answers is stopped (its
  // child process is closed), not left running. The run's own signal ends this as well.
  const limit = AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]);
  const stop = aborted(limit);
  try {
    const listed = await Promise.race([
      (async () => {
        await client.connect(transport as never);
        return client.listTools();
      })(),
      stop.promise,
    ]);
    const names = new Map<string, string>();
    for (const row of ALL_BINDINGS.filter((item) => item.integration === integration)) {
      const hit = row.candidates.find((candidate) => listed.tools.some((tool) => tool.name === candidate));
      if (hit) names.set(row.toolId, hit);
    }
    bindingCache().set(integration, { names, checkedAt: Date.now() });
    return { client, listed: { names, listed: listed.tools.map((tool) => tool.name) } };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  } finally {
    stop.stop();
  }
}

/** Turns anything thrown while connecting or calling into one ConnectorError with a fixed sentence. */
function remapError(integration: IntegrationId, error: unknown): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const message = error instanceof Error ? error.message : "";
  if (/\b(401|403)\b|unauthori[sz]ed/i.test(message)) {
    markRejected(integration);
    return new ConnectorError("rejected_credentials");
  }
  return new ConnectorError("service_error");
}

/** tools/list only. Live probes use this so they never call a write tool or read mail. */
export async function probeIntegration(integration: IntegrationId): Promise<{ listed: string[]; resolved: { toolId: string; bound: string | null }[] }> {
  let client: { close(): Promise<void> } | undefined;
  try {
    const opened = await connectAndList(integration, new AbortController().signal);
    client = opened.client;
    const ours = ALL_BINDINGS.filter((row) => row.integration === integration);
    return {
      listed: opened.listed.listed,
      resolved: ours.map((row) => ({ toolId: row.toolId, bound: opened.listed.names.get(row.toolId) ?? null })),
    };
  } catch (error) {
    throw remapError(integration, error);
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
  let client: Opened["client"] | undefined;
  try {
    const opened = await connectAndList(integration, signal);
    client = opened.client;
    const bound = opened.listed.names.get(toolId);
    if (!bound) throw new ConnectorError("not_connected");
    const limit = AbortSignal.any([signal, AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS)]);
    const stop = aborted(limit);
    let result: unknown;
    try {
      result = await Promise.race([client.callTool({ name: bound, arguments: args }), stop.promise]);
    } finally {
      stop.stop();
    }
    if (isRec(result) && result.isError) {
      if (AUTH_FAILURE.test(toolErrorText(result))) {
        markRejected(integration);
        throw new ConnectorError("rejected_credentials");
      }
      throw new ConnectorError("service_error"); // a bad request or a page that is not shared: not a credential problem
    }
    return parseResult(result);
  } catch (error) {
    throw remapError(integration, error);
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
