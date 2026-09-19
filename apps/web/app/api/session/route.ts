import { ensureUser, MIN_TOKEN_LENGTH } from "@/src/auth";
import { errorJson, json, optionsResponse } from "@/src/json";

export const runtime = "nodejs";

export function OPTIONS() {
  return optionsResponse();
}

export async function POST(request: Request) {
  let body: { deviceToken?: unknown };
  try {
    body = (await request.json()) as { deviceToken?: unknown };
  } catch {
    return errorJson("Invalid JSON", 400);
  }

  const deviceToken = typeof body.deviceToken === "string" ? body.deviceToken : "";
  if (deviceToken.length < MIN_TOKEN_LENGTH) {
    return errorJson(`deviceToken must be at least ${MIN_TOKEN_LENGTH} characters`, 400);
  }

  try {
    const user = await ensureUser(deviceToken);
    if (!user) return errorJson("Could not create user", 500);
    return json({ userId: user.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Pairing failed";
    return errorJson(message, 500);
  }
}
