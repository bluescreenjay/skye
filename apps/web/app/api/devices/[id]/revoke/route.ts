import { requireUser } from "@/src/auth";
import { query } from "@/src/db";
import { errorJson, json, optionsResponse } from "@/src/json";

export const runtime = "nodejs";
export function OPTIONS() { return optionsResponse(); }

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  const { id } = await context.params;
  const result = await query(
    "UPDATE devices SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id",
    [id, user!.id],
  );
  if (!result.rows[0]) return errorJson("Device not found", 404);
  return json({ revoked: true });
}
