import type { Device } from "@ai-browser/shared";
import { loadConfig } from "../config";

type Offer = { code: string; expiresAt: string; qrUrl: string };

function headers(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" };
}

async function responseJson<T>(response: Response): Promise<T | null> {
  return response.json().catch(() => null) as Promise<T | null>;
}

export async function createPairingOffer(): Promise<Offer | null> {
  const config = loadConfig(import.meta.env);
  if (!config.ok) return null;
  const response = await fetch(`${config.config.apiBaseUrl}/api/pairing/offers`, { method: "POST", headers: headers(config.config.deviceToken) });
  const body = await responseJson<{ offer?: Offer }>(response);
  return response.ok ? body?.offer ?? null : null;
}

export async function loadDevices(): Promise<Device[]> {
  const config = loadConfig(import.meta.env);
  if (!config.ok) return [];
  const response = await fetch(`${config.config.apiBaseUrl}/api/devices`, { headers: headers(config.config.deviceToken) });
  const body = await responseJson<{ devices?: Device[] }>(response);
  return response.ok ? body?.devices ?? [] : [];
}

export async function revokeDevice(id: string): Promise<boolean> {
  const config = loadConfig(import.meta.env);
  if (!config.ok) return false;
  const response = await fetch(`${config.config.apiBaseUrl}/api/devices/${encodeURIComponent(id)}/revoke`, { method: "POST", headers: headers(config.config.deviceToken) });
  return response.ok;
}
