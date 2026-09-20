// Exchange GOOGLE_REFRESH_TOKEN at Google's token endpoint. Cache until 60s before expiry.
import { markRejected } from "./config";
import { ConnectorError } from "./connector";
import { TOKEN_EXPIRY_SKEW_MS } from "../limits";

type Cached = { accessToken: string; expiresAt: number };
type Holder = typeof globalThis & { __aiBrowserGoogleToken?: Cached };

const TOKEN_URL = "https://oauth2.googleapis.com/token";

export function resetGoogleTokenForTests(): void {
  delete (globalThis as Holder).__aiBrowserGoogleToken;
}

let fetchImpl: typeof fetch = fetch;
export function setGoogleTokenFetchForTests(fn: typeof fetch | null): void {
  fetchImpl = fn ?? fetch;
}

export async function googleAccessToken(): Promise<string> {
  const holder = globalThis as Holder;
  const cached = holder.__aiBrowserGoogleToken;
  if (cached && cached.expiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now()) return cached.accessToken;
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const refresh = process.env.GOOGLE_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refresh) throw new ConnectorError("not_connected");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refresh,
  });
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new ConnectorError("service_error");
  }
  if (!response.ok) {
    markRejected("drive");
    markRejected("gmail");
    markRejected("calendar");
    throw new ConnectorError("rejected_credentials");
  }
  const json = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    markRejected("drive");
    markRejected("gmail");
    markRejected("calendar");
    throw new ConnectorError("rejected_credentials");
  }
  const expiresAt = Date.now() + Math.max(1, (json.expires_in ?? 3600) * 1000);
  holder.__aiBrowserGoogleToken = { accessToken: json.access_token, expiresAt };
  return json.access_token;
}
