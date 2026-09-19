// Build-time configuration (spec FR-012). The values come from
// apps/extension/.env via Vite's import.meta.env; there is no settings screen.
// This module reads only the two variables below and never puts the token in a
// message or log line.

export interface Config {
  apiBaseUrl: string;
  deviceToken: string;
}

export type ConfigResult =
  | { ok: true; config: Config }
  | { ok: false; reason: string };

type Env = Record<string, unknown>;

export function loadConfig(env: Env): ConfigResult {
  const base = String(env.VITE_API_BASE_URL ?? "").trim();
  const token = String(env.VITE_DEVICE_TOKEN ?? "").trim();

  if (!base) return { ok: false, reason: "VITE_API_BASE_URL is empty" };
  if (!token) return { ok: false, reason: "VITE_DEVICE_TOKEN is empty" };

  let protocol: string;
  try {
    protocol = new URL(base).protocol;
  } catch {
    return { ok: false, reason: "VITE_API_BASE_URL is not a valid URL" };
  }
  if (protocol !== "http:" && protocol !== "https:") {
    return { ok: false, reason: "VITE_API_BASE_URL must start with http:// or https://" };
  }

  return { ok: true, config: { apiBaseUrl: base.replace(/\/+$/, ""), deviceToken: token } };
}

/**
 * Reads the config once and remembers it. A missing or invalid config logs a
 * single warning, however many times get() is called.
 */
export function createConfigLoader(
  env: Env = import.meta.env,
  warn: (message: string) => void = (message) => console.warn(message),
) {
  let cached: ConfigResult | undefined;
  return {
    get(): ConfigResult {
      if (!cached) {
        cached = loadConfig(env);
        if (!cached.ok) {
          warn(`[ai-browser] Tab ingestion is idle: ${cached.reason}. See apps/extension/.env.example.`);
        }
      }
      return cached;
    },
  };
}
