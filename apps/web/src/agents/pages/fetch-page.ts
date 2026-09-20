// Reads ONE public web page (specs/010-workspace-agents/research.md section 2, contracts/model.md
// "The transport's rules"). It uses Node's own `https`, not the global `fetch`, because the safety
// rule has to apply to the address the SOCKET connects to: a custom `lookup` resolves the name,
// refuses unless every answer is a public address, and hands the socket one of those already checked
// answers, so DNS changing between a check and the connect cannot redirect it. Redirects are
// followed by hand and every hop is checked again. Nothing personal is ever sent (no cookies, no
// authorization), the body is size-capped after decompression, and the whole page has a time limit.
// It never throws and never logs; every failure is one of the fixed reasons.
import dns from "node:dns";
import https from "node:https";
import type net from "node:net";
import zlib from "node:zlib";
import { promisify } from "node:util";
import type { AgentNotReadReason } from "@ai-browser/shared";
import { MAX_REDIRECTS, pageBytes, pageChars, pageTimeoutMs } from "../limits";
import { cutText, extractText, looksLikeSignIn, MIN_PAGE_TEXT, normalizeText } from "./extract";
import { checkAddress, isPublicAddress } from "./safe-address";

export interface PageResult {
  /** The extracted text, or null when the page was not read. */
  text: string | null;
  reason: AgentNotReadReason | null;
  /** The text was cut at the per-page limit. */
  truncated: boolean;
}

export type ResolveFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

/** What the transport hands back once the response headers arrive. */
export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}

export interface RequestInit {
  headers: Record<string, string>;
  /** The checked lookup the connection MUST use to find the address to connect to. */
  lookup: net.LookupFunction;
  signal: AbortSignal;
}

/** The one place a socket is opened. Tests inject a fake; nothing else replaces it. */
export type RequestFn = (url: URL, init: RequestInit) => Promise<RawResponse>;

export interface FetchOptions {
  request?: RequestFn;
  resolve?: ResolveFn;
  /** Stops the read when it aborts (the reading step's own time limit). */
  signal?: AbortSignal;
}

export const USER_AGENT = "AIBrowserReader/1.0 (reads one public page for the person who asked; sends no cookies)";
const ACCEPT = "text/html,application/xhtml+xml,text/plain";
const ALLOWED_TYPES = new Set(["text/html", "application/xhtml+xml", "text/plain"]);
// Where a redirect that leads to a login page points: judged on the host and path only.
const LOGIN_LIKE = /(^|[^a-z0-9])(login|signin|sign-in|sso|auth|cas|oauth2?|saml2?)([^a-z0-9]|$)/;

/** Thrown into the socket when a name resolves to something that is not public. */
class PrivateAddressError extends Error {
  readonly code = "ERR_PRIVATE_ADDRESS";
}
class AbortedError extends Error {
  readonly code = "ERR_ABORTED";
}

const defaultResolve: ResolveFn = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * The `lookup` given to the socket. It resolves ALL addresses and refuses unless every one is
 * public, then answers with checked addresses only. It supports both shapes Node uses: one address
 * (`all` false) and an array (`all` true, which `autoSelectFamily` uses on Node 20 and later).
 */
export function makeCheckedLookup(resolve: ResolveFn = defaultResolve): net.LookupFunction {
  return (hostname, options, callback) => {
    const wantAll = typeof options === "object" && options !== null && options.all === true;
    const family = typeof options === "number" ? options : options?.family;
    let answered = false;
    const answer = (error: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => {
      if (answered) return;
      answered = true;
      if (error) return callback(error, wantAll ? [] : "", undefined);
      if (wantAll) return callback(null, addresses.map(({ address, family: f }) => ({ address, family: f })));
      callback(null, addresses[0].address, addresses[0].family);
    };
    resolve(hostname).then(
      (found) => {
        if (found.length === 0) return answer(new Error("no address") as NodeJS.ErrnoException, []);
        if (!found.every((a) => isPublicAddress(a.address))) return answer(new PrivateAddressError("not a public address"), []);
        const wanted = family === 4 || family === 6 ? found.filter((a) => a.family === family) : found;
        if (wanted.length === 0) return answer(new Error("no address") as NodeJS.ErrnoException, []);
        answer(null, wanted);
      },
      (error: unknown) => answer(error instanceof Error ? (error as NodeJS.ErrnoException) : new Error("lookup failed"), []),
    );
  };
}

/** Rejects as soon as `signal` aborts, whatever `promise` is doing. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new AbortedError("aborted"));
    const onAbort = () => reject(new AbortedError("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const httpsRequest: RequestFn = (url, init) =>
  new Promise<RawResponse>((resolve, reject) => {
    const request = https.request(
      {
        protocol: "https:",
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: init.headers,
        lookup: init.lookup,
        agent: false, // a fresh connection: never pooled with another host's
        signal: init.signal,
      },
      (response) => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response, destroy: () => response.destroy() }),
    );
    request.on("error", reject);
    request.end();
  });

const fail = (reason: AgentNotReadReason): PageResult => ({ text: null, reason, truncated: false });
const headerOf = (headers: RawResponse["headers"], name: string): string => {
  const value = headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
};

const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const gunzip = promisify(zlib.gunzip);
const brotli = promisify(zlib.brotliDecompress);

/** Decompresses with a hard limit on the output, so a compression bomb hits the cap instead of memory. */
async function decompress(body: Buffer, encoding: string, limit: number): Promise<Buffer | AgentNotReadReason> {
  const options = { maxOutputLength: limit };
  try {
    switch (encoding) {
      case "":
      case "identity":
        return body;
      case "gzip":
      case "x-gzip":
        return await gunzip(body, options);
      case "br":
        return await brotli(body, options);
      case "deflate":
        try {
          return await inflate(body, options);
        } catch (error) {
          if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw error;
          return await inflateRaw(body, options); // some servers send deflate without the wrapper
        }
      default:
        return "error";
    }
  } catch (error) {
    return (error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" ? "too_large" : "error";
  }
}

/** Reads a body up to `limit` bytes; null when it is larger. Stops at once when `signal` aborts. */
async function readCapped(response: RawResponse, limit: number, signal: AbortSignal): Promise<Buffer | null> {
  const iterator = response.body[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const step = await raceAbort(iterator.next(), signal);
      if (step.done) return Buffer.concat(chunks);
      total += step.value.length;
      if (total > limit) return null;
      chunks.push(Buffer.from(step.value));
    }
  } finally {
    response.destroy();
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
}

function decode(body: Buffer, contentType: string): string {
  const charset = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body); // an unknown label
  }
}

async function readOnce(plainUrl: string, options: FetchOptions, signal: AbortSignal): Promise<PageResult> {
  const request = options.request ?? httpsRequest;
  const lookup = makeCheckedLookup(options.resolve);
  const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: ACCEPT, "Accept-Encoding": "gzip, deflate, br", Connection: "close" };

  const first = checkAddress(plainUrl);
  if (!first.ok) return fail(first.reason);
  let target = new URL(first.plain);

  for (let redirects = 0; ; redirects += 1) {
    const response = await raceAbort(request(target, { headers, lookup, signal }), signal);
    try {
      const { status } = response;

      if (status >= 300 && status < 400 && status !== 304) {
        const location = headerOf(response.headers, "location");
        if (location === "") return fail("error");
        let next: URL;
        try {
          next = new URL(location, target);
        } catch {
          return fail("error");
        }
        const checked = checkAddress(next.href); // every hop is judged again, http: included
        if (!checked.ok) return fail(checked.reason);
        if (LOGIN_LIKE.test(`${next.hostname}${next.pathname}`.toLowerCase())) return fail("needs_sign_in");
        if (redirects >= MAX_REDIRECTS) return fail("error");
        next.hash = "";
        target = next;
        continue;
      }
      if (status === 401 || status === 403) return fail("needs_sign_in");
      if (status < 200 || status >= 300) return fail("error");

      const contentType = headerOf(response.headers, "content-type");
      const type = contentType.split(";")[0].trim().toLowerCase();
      if (!ALLOWED_TYPES.has(type)) return fail("not_a_web_page");

      const limit = pageBytes();
      const encoding = headerOf(response.headers, "content-encoding").toLowerCase();
      const declared = Number(headerOf(response.headers, "content-length"));
      if ((encoding === "" || encoding === "identity") && Number.isFinite(declared) && declared > limit) return fail("too_large");

      const raw = await readCapped(response, limit, signal);
      if (raw === null) return fail("too_large");
      const inflated = await decompress(raw, encoding, limit);
      if (typeof inflated === "string") return fail(inflated);

      const decoded = decode(inflated, contentType);
      if (type === "text/plain") {
        const cut = cutText(normalizeText(decoded), pageChars());
        return cut.text.length < MIN_PAGE_TEXT ? fail("no_text") : { text: cut.text, reason: null, truncated: cut.truncated };
      }
      const extracted = extractText(decoded, pageChars());
      if (looksLikeSignIn(decoded, extracted.text)) return fail("needs_sign_in");
      if (extracted.text.length < MIN_PAGE_TEXT) return fail("no_text");
      return { text: extracted.text, reason: null, truncated: extracted.truncated };
    } finally {
      response.destroy();
    }
  }
}

/**
 * Reads one page at its plain address. Never throws, never logs. `options.request` and
 * `options.resolve` exist so tests can run without a network.
 */
export async function fetchPage(plainUrl: string, options: FetchOptions = {}): Promise<PageResult> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (options.signal?.aborted) return fail("too_slow");
  options.signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, pageTimeoutMs());
  try {
    return await readOnce(plainUrl, options, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) return fail("too_slow");
    if ((error as { code?: string } | null)?.code === "ERR_PRIVATE_ADDRESS") return fail("private_address");
    return fail("error");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
  }
}
