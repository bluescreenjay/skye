// ToolConnector seam (contracts/integrations.md). Availability is status + binding; no network on card open.
import type { IntegrationId, SearchItem } from "@ai-browser/shared";
import { connectionStatus, type ConnectionStatus } from "./config";
import { bindingFor } from "./bindings";

export type ConnectorErrorCode = "not_connected" | "rejected_credentials" | "service_error" | "timed_out";

const AGAIN = "You can try again.";

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  constructor(code: ConnectorErrorCode, message = messageFor(code)) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
  }
}

function messageFor(code: ConnectorErrorCode): string {
  if (code === "not_connected" || code === "rejected_credentials") return `Connect this service to use this action. ${AGAIN}`;
  if (code === "timed_out") return `This run did not finish. ${AGAIN}`;
  return `That service didn't complete this action. ${AGAIN}`;
}

export interface ConnectorResult {
  text: string;
  links: { label: string; url: string | null; id: string | null }[];
  items?: SearchItem[];
  mail?: { from: string; subject: string; date: string; excerpt: string }[];
  /** Calendar look-up rows. Private: shown to the owner once and never stored or given to the AI. */
  events?: { title: string; start: string; end: string; allDay: boolean }[];
}

export interface ToolConnector {
  status(integration: IntegrationId): ConnectionStatus;
  available(toolId: string): boolean;
  call(toolId: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ConnectorResult>;
}

let override: ToolConnector | null = null;

export function setConnectorForTests(fake: ToolConnector | null): void {
  override = fake;
}

const envConnector: ToolConnector = {
  status: (id) => connectionStatus(id),
  available(toolId: string) {
    const binding = bindingFor(toolId);
    if (!binding) return false;
    return connectionStatus(binding.integration) === "connected";
  },
  async call(toolId, args, signal) {
    const { mcpConnector } = await import("./mcp-client");
    return mcpConnector().call(toolId, args, signal);
  },
};

export function getConnector(): ToolConnector {
  return override ?? envConnector;
}
