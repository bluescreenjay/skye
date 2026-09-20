// The address rules of the page reader (specs/010-workspace-agents/research.md section 2 and
// contracts/model.md "The transport's rules"). Pure functions, no I/O. There are two layers, and both
// must hold: `checkAddress` judges the URL text before any request, and `isPublicAddress` judges the
// numeric address the socket is about to connect to (fetch-page.ts). The second is the one that
// survives odd hostnames, redirects, and DNS rebinding. When in doubt an address is NOT public.
import net from "node:net";

/** Why an address was refused. */
export type Refusal = "private_address" | "not_secure";

const NON_PUBLIC_V4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // includes the cloud metadata address 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

// IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) addresses are judged by their embedded IPv4.
const NON_PUBLIC_V6: [string, number][] = [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

const blocked = new net.BlockList();
for (const [address, prefix] of NON_PUBLIC_V4) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of NON_PUBLIC_V6) blocked.addSubnet(address, prefix, "ipv6");

function parseIPv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null;
}

/** The eight 16-bit groups of an IPv6 address, or null when it does not parse. */
function parseIPv6(input: string): number[] | null {
  let text = input;
  if (text.includes(".")) {
    const cut = text.lastIndexOf(":");
    const v4 = parseIPv4(text.slice(cut + 1));
    if (!v4) return null;
    text = `${text.slice(0, cut + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves.length === 2 && halves[1] !== "" ? halves[1].split(":") : [];
  let groups = head;
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  }
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** The IPv4 address embedded in an IPv4-mapped or NAT64 IPv6 address, else null. */
function embeddedV4(groups: number[]): string | null {
  const zeros = (from: number, to: number) => groups.slice(from, to).every((g) => g === 0);
  const mapped = zeros(0, 5) && groups[5] === 0xffff;
  const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && zeros(2, 6);
  if (!mapped && !nat64) return null;
  return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
}

/** True only for a numeric address that is on the public internet. Anything that does not parse is not public. */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return !blocked.check(ip, "ipv4");
  if (family !== 6 || ip.includes("%")) return false; // a zone id ("fe80::1%en0") is never a public address
  const groups = parseIPv6(ip);
  if (!groups) return false;
  const embedded = embeddedV4(groups);
  if (embedded !== null) return !blocked.check(embedded, "ipv4");
  if ((groups[0] & 0xe000) !== 0x2000) return false; // only global unicast (2000::/3) is on the public internet
  return !blocked.check(ip, "ipv6");
}

const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

/** True for a hostname that must never be requested: an IP literal, a local name, or a single label. */
export function isBlockedHostname(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name === "" || name.startsWith("[") || net.isIP(name) !== 0) return true; // IP literals, v4 and [v6]
  if (name === "home.arpa" || !name.includes(".")) return true; // includes plain "localhost"
  return PRIVATE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export type AddressCheck = { ok: true; plain: string; trimmed: boolean } | { ok: false; reason: Refusal };

/**
 * Judges an address before any request. Only `https:` on the default port, without user-info, to a
 * public-looking hostname passes. The plain address has no query string and no fragment, and
 * `trimmed` says whether one was removed.
 */
export function checkAddress(url: string): AddressCheck {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "private_address" };
  }
  if (parsed.protocol === "http:") return { ok: false, reason: "not_secure" };
  if (parsed.protocol !== "https:") return { ok: false, reason: "private_address" };
  if (parsed.username !== "" || parsed.password !== "") return { ok: false, reason: "private_address" };
  if (parsed.port !== "") return { ok: false, reason: "private_address" }; // the default port is dropped by URL, so any other one shows here
  if (isBlockedHostname(parsed.hostname)) return { ok: false, reason: "private_address" };
  const trimmed = parsed.search !== "" || parsed.hash !== "";
  parsed.search = "";
  parsed.hash = "";
  return { ok: true, plain: parsed.toString(), trimmed };
}
