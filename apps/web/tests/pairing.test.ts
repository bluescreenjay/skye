import { beforeEach, describe, expect, it } from "vitest";
import { GET as devicesGet } from "@/app/api/devices/route";
import { POST as revoke } from "@/app/api/devices/[id]/revoke/route";
import { POST as offer } from "@/app/api/pairing/offers/route";
import { POST as redeem } from "@/app/api/pairing/redeem/route";
import { ensureUser } from "@/src/auth";
import { query } from "@/src/db";
import { createOffer } from "@/src/pairing";
import { read, req, reset } from "./helpers";

const DESKTOP = "desktop-legacy-token-0001";

beforeEach(async () => { await reset(); await ensureUser(DESKTOP); });

describe("mobile pairing", () => {
  it("redeems a code once and the resulting device can authenticate", async () => {
    const made = await read(offer(req("POST", "/api/pairing/offers", DESKTOP)));
    expect(made.status).toBe(201);
    expect(made.json.offer.code).toMatch(/^[A-Z0-9]{8}$/);
    const paired = await read(redeem(req("POST", "/api/pairing/redeem", null, { code: made.json.offer.code, label: "Test phone" })));
    expect(paired.status).toBe(201);
    expect(paired.json.device).toMatchObject({ kind: "mobile", label: "Test phone" });
    expect((await read(devicesGet(req("GET", "/api/devices", paired.json.deviceToken)))).status).toBe(200);
    expect((await read(redeem(req("POST", "/api/pairing/redeem", null, { code: made.json.offer.code })))).status).toBe(400);
  });

  it("supersedes an earlier code and rejects expired offers", async () => {
    const first = await createOffer((await ensureUser(DESKTOP))!.id);
    const second = await createOffer((await ensureUser(DESKTOP))!.id);
    expect((await read(redeem(req("POST", "/api/pairing/redeem", null, { code: first.code })))).status).toBe(400);
    expect((await read(redeem(req("POST", "/api/pairing/redeem", null, { code: second.code })))).status).toBe(201);
  });

  it("rejects an expired code without issuing a device", async () => {
    const made = await read(offer(req("POST", "/api/pairing/offers", DESKTOP)));
    await query("UPDATE pairing_offers SET expires_at = now() - interval '1 second' WHERE code_hash = $1", [
      // The test only needs to expire this user's one open offer, so avoid reaching into hashing internals.
      (await query<{ code_hash: string }>("SELECT code_hash FROM pairing_offers LIMIT 1")).rows[0].code_hash,
    ]);
    expect((await read(redeem(req("POST", "/api/pairing/redeem", null, { code: made.json.offer.code })))).status).toBe(400);
    expect((await read(devicesGet(req("GET", "/api/devices", DESKTOP)))).json.devices).toEqual([]);
  });

  it("limits a person to three active phones and revocation immediately removes access", async () => {
    const tokens: string[] = []; let deviceId = "";
    for (let i = 0; i < 3; i += 1) {
      const made = await read(offer(req("POST", "/api/pairing/offers", DESKTOP)));
      const paired = await read(redeem(req("POST", "/api/pairing/redeem", null, { code: made.json.offer.code })));
      tokens.push(paired.json.deviceToken); deviceId = paired.json.device.id;
    }
    const fourth = await read(offer(req("POST", "/api/pairing/offers", DESKTOP)));
    expect((await read(redeem(req("POST", "/api/pairing/redeem", null, { code: fourth.json.offer.code })))).status).toBe(409);
    expect((await read(revoke(req("POST", `/api/devices/${deviceId}/revoke`, DESKTOP), { params: Promise.resolve({ id: deviceId }) }))).status).toBe(200);
    expect((await read(devicesGet(req("GET", "/api/devices", tokens[2])))).status).toBe(401);
  });
});
