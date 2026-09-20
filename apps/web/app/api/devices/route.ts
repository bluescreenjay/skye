import { requireUser } from "@/src/auth";
import { query } from "@/src/db";
import { json, optionsResponse } from "@/src/json";
import { mapDevice } from "@/src/pairing";

export const runtime = "nodejs";
export function OPTIONS() { return optionsResponse(); }

export async function GET(request: Request) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  const result = await query<Parameters<typeof mapDevice>[0]>(
    "SELECT id, user_id, kind, label, created_at, revoked_at FROM devices WHERE user_id = $1 ORDER BY created_at DESC",
    [user!.id],
  );
  return json({ devices: result.rows.map(mapDevice) });
}
