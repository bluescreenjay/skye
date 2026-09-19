import { randomBytes, randomUUID } from "crypto";
import type { PoolClient } from "pg";
import type { Device } from "@ai-browser/shared";
import { hashDeviceToken } from "@/src/auth";
import { withTransaction } from "@/src/db";

const OFFER_LIFETIME_MS = 5 * 60 * 1000;
const MAX_MOBILE_DEVICES = 3;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type DbDevice = {
  id: string;
  user_id: string;
  kind: "extension" | "mobile";
  label: string | null;
  created_at: Date | string;
  revoked_at: Date | string | null;
};

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function mapDevice(row: DbDevice): Device {
  return { id: row.id, userId: row.user_id, kind: row.kind, label: row.label, createdAt: iso(row.created_at)!, revokedAt: iso(row.revoked_at) };
}

/** Codes avoid ambiguous characters and are normalized before hashing. */
export function normalizePairingCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashPairingCode(code: string): string {
  return hashDeviceToken(`pairing:${normalizePairingCode(code)}`);
}

function newCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function createOffer(userId: string) {
  const code = newCode();
  const expiresAt = new Date(Date.now() + OFFER_LIFETIME_MS);
  await withTransaction(async (client) => {
    await client.query(
      "UPDATE pairing_offers SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > now()",
      [userId],
    );
    await client.query(
      "INSERT INTO pairing_offers (id, user_id, code_hash, expires_at) VALUES ($1, $2, $3, $4)",
      [randomUUID(), userId, hashPairingCode(code), expiresAt],
    );
  });
  return { code, expiresAt: expiresAt.toISOString() };
}

export class PairingError extends Error {
  constructor(message: string, readonly status: 400 | 409) {
    super(message);
  }
}

function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label ? label.slice(0, 80) : null;
}

async function lockUser(client: PoolClient, userId: string) {
  await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
}

export async function redeemOffer(rawCode: unknown, rawLabel: unknown) {
  if (typeof rawCode !== "string" || normalizePairingCode(rawCode).length !== 8) {
    throw new PairingError("Pairing code is invalid or has expired", 400);
  }
  const token = newToken();
  const device = await withTransaction(async (client) => {
    const offer = await client.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM pairing_offers
       WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()
       FOR UPDATE`,
      [hashPairingCode(rawCode)],
    );
    const row = offer.rows[0];
    if (!row) throw new PairingError("Pairing code is invalid or has expired", 400);
    await lockUser(client, row.user_id);
    const count = await client.query<{ count: string }>(
      "SELECT count(*) FROM devices WHERE user_id = $1 AND kind = 'mobile' AND revoked_at IS NULL",
      [row.user_id],
    );
    if (Number(count.rows[0].count) >= MAX_MOBILE_DEVICES) {
      throw new PairingError("Maximum of 3 active mobile devices reached", 409);
    }
    const inserted = await client.query<DbDevice>(
      `INSERT INTO devices (id, user_id, token_hash, kind, label)
       VALUES ($1, $2, $3, 'mobile', $4)
       RETURNING id, user_id, kind, label, created_at, revoked_at`,
      [randomUUID(), row.user_id, hashDeviceToken(token), cleanLabel(rawLabel)],
    );
    await client.query("UPDATE pairing_offers SET consumed_at = now() WHERE id = $1", [row.id]);
    return mapDevice(inserted.rows[0]);
  });
  return { deviceToken: token, device };
}
