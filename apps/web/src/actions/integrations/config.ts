// Integration configuration from the environment (specs/010b-mcp-action-tools/contracts/integrations.md).
// Read at call time so tests can set sentinel secrets. Never logs a secret.
import type { IntegrationId } from "@ai-browser/shared";
import { BINDING_CACHE_MS, REJECTED_TTL_MS } from "../limits";

export type ConnectionStatus = "connected" | "missing" | "rejected";

export type Transport =
  | { kind: "http"; url: string }
  | { kind: "stdio"; command: string; args: string[] };

export interface IntegrationConfig {
  id: IntegrationId;
  transport: Transport | null;
  credentialPresent: boolean;
  destination: string | null;
}

type Health = { rejectedUntil: number };

type Holder = typeof globalThis & { __aiBrowserIntegrationHealth?: Map<IntegrationId, Health> };

function health(): Map<IntegrationId, Health> {
  const holder = globalThis as Holder;
  return (holder.__aiBrowserIntegrationHealth ??= new Map());
}

export function resetIntegrationHealthForTests(): void {
  delete (globalThis as Holder).__aiBrowserIntegrationHealth;
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    return [];
  }
  return [];
}

function transportOf(prefix: string): Transport | null {
  const url = env(`MCP_${prefix}_URL`);
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:") return { kind: "http", url };
      if (parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) {
        return { kind: "http", url };
      }
    } catch {
      return null;
    }
    return null;
  }
  const command = env(`MCP_${prefix}_COMMAND`);
  if (command) return { kind: "stdio", command, args: parseArgs(env(`MCP_${prefix}_ARGS`)) };
  return null;
}

function googleCredentialPresent(): boolean {
  return Boolean(env("GOOGLE_CLIENT_ID") && env("GOOGLE_CLIENT_SECRET") && env("GOOGLE_REFRESH_TOKEN"));
}

export function integrationConfig(id: IntegrationId): IntegrationConfig {
  switch (id) {
    case "github":
      return {
        id,
        transport: transportOf("GITHUB"),
        credentialPresent: Boolean(env("MCP_GITHUB_TOKEN")),
        destination: env("GITHUB_REPO") ?? null,
      };
    case "jira":
      return {
        id,
        transport: transportOf("JIRA"),
        credentialPresent: Boolean(env("MCP_JIRA_TOKEN")),
        destination: env("JIRA_PROJECT_KEY") ?? null,
      };
    case "notion":
      return {
        id,
        transport: transportOf("NOTION"),
        credentialPresent: Boolean(env("MCP_NOTION_TOKEN")),
        destination: env("NOTION_PARENT_PAGE_ID") ?? null,
      };
    case "slack":
      return {
        id,
        transport: transportOf("SLACK"),
        credentialPresent: Boolean(env("MCP_SLACK_TOKEN")),
        destination: env("SLACK_CHANNEL_ID") ?? null,
      };
    case "drive":
      return {
        id,
        transport: transportOf("GOOGLE_DRIVE"),
        credentialPresent: googleCredentialPresent(),
        destination: env("DRIVE_FOLDER_ID") ?? null,
      };
    case "gmail":
      return {
        id,
        transport: transportOf("GOOGLE_GMAIL"),
        credentialPresent: googleCredentialPresent(),
        destination: "mailbox",
      };
  }
}

export function markRejected(id: IntegrationId, until = Date.now() + REJECTED_TTL_MS): void {
  health().set(id, { rejectedUntil: until });
}

export function connectionStatus(id: IntegrationId): ConnectionStatus {
  const until = health().get(id)?.rejectedUntil ?? 0;
  if (until > Date.now()) return "rejected";
  const cfg = integrationConfig(id);
  if (!cfg.transport || !cfg.credentialPresent || !cfg.destination) return "missing";
  return "connected";
}

export function ownerUserId(): string | null {
  const id = env("INTEGRATION_OWNER_USER_ID");
  return id ?? null;
}

export function isOwner(userId: string): boolean {
  const owner = ownerUserId();
  return owner !== null && owner === userId;
}

export function serviceLabel(id: IntegrationId): string {
  if (id === "drive" || id === "gmail") return "Google";
  if (id === "github") return "GitHub";
  if (id === "jira") return "Jira";
  if (id === "notion") return "Notion";
  return "Slack";
}

export const TEAM_INTEGRATIONS: IntegrationId[] = ["github", "jira", "notion", "slack"];
export const GOOGLE_INTEGRATIONS: IntegrationId[] = ["drive", "gmail"];

export const BINDING_CACHE_TTL = BINDING_CACHE_MS;
