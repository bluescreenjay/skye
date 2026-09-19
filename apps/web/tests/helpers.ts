import { query } from "@/src/db";

/**
 * Fresh database for each test: removing users cascades to every table. This
 * deletes everything, so it refuses to run against anything but a local database.
 */
export async function reset() {
  const host = new URL(process.env.DATABASE_URL ?? "postgres://none").hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Refusing to wipe the database: DATABASE_URL points at "${host}", not a local test database.`);
  }
  await query("TRUNCATE users CASCADE");
}

export function req(method: string, path: string, token: string | null, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Reply = { status: number; json: any };

export async function read(res: Response | Promise<Response>): Promise<Reply> {
  const r = await res;
  return { status: r.status, json: await r.json().catch(() => null) };
}

const stamp = () => new Date().toISOString();

export const uuid = () => crypto.randomUUID();

export function tab(chromeTabId: number, url: string, over: Record<string, unknown> = {}) {
  return {
    chromeTabId,
    windowId: 1,
    active: false,
    url,
    title: `Title ${chromeTabId}`,
    snippet: "",
    lastSeenAt: stamp(),
    ...over,
  };
}

export function event(chromeTabId: number, url: string, eventType = "opened", over: Record<string, unknown> = {}) {
  return { id: uuid(), time: stamp(), chromeTabId, url, title: "t", eventType, ...over };
}

export function batch(over: Record<string, unknown> = {}) {
  return {
    batchId: uuid(),
    sentAt: stamp(),
    fullSnapshot: false,
    active: { windowId: null, chromeTabId: null },
    tabs: [],
    events: [],
    ...over,
  };
}
