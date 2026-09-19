import { requireUser } from "@/src/auth";
import { createOffer } from "@/src/pairing";
import { json, optionsResponse } from "@/src/json";

export const runtime = "nodejs";
export function OPTIONS() { return optionsResponse(); }

export async function POST(request: Request) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  const offer = await createOffer(user!.id);
  const mobileOrigin = (process.env.MOBILE_ORIGIN ?? "http://localhost:5174").replace(/\/+$/, "");
  return json({ offer: { ...offer, qrUrl: `${mobileOrigin}/pair?code=${encodeURIComponent(offer.code)}` } }, 201);
}
