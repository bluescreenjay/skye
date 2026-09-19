import { errorJson, json, optionsResponse } from "@/src/json";
import { PairingError, redeemOffer } from "@/src/pairing";

export const runtime = "nodejs";
export function OPTIONS() { return optionsResponse(); }

export async function POST(request: Request) {
  let body: { code?: unknown; label?: unknown };
  try { body = await request.json(); } catch { return errorJson("Invalid JSON", 400); }
  try {
    return json(await redeemOffer(body.code, body.label), 201);
  } catch (error) {
    if (error instanceof PairingError) return errorJson(error.message, error.status);
    throw error;
  }
}
