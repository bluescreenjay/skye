// Turns a page into plain text without a dependency (specs/010-workspace-agents/research.md
// section 4). One linear scan over the HTML (no regex over the whole document, so a hostile page of
// unclosed tags cannot make it slow): code and hidden blocks are dropped, `<main>` and `<article>`
// are preferred, otherwise the body without navigation, header, footer, aside, and forms is used.
// The output is plain text, never markup, and everything in it is untrusted. Pure; nothing logs.

/** The text of a page is unusable (an app shell, a login page) below this many characters. */
export const MIN_PAGE_TEXT = 200;
const MIN_MAIN_TEXT = 200;

// Content that is raw text up to a closing tag: skipped without looking inside.
const SKIP_RAW = new Set(["script", "style", "iframe"]);
// Content that can hold tags and nest: skipped by counting matching open and close tags.
const SKIP_NESTED = new Set(["noscript", "template", "svg", "head"]);
const DROP_OUTSIDE_MAIN = new Set(["nav", "header", "footer", "aside", "form"]);
const MAIN_TAGS = new Set(["main", "article"]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section",
  "summary", "table", "tr", "ul",
]);
const CELL = new Set(["td", "th"]);

const PUNCTUATION_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ndash: "\u2013", mdash: "\u2014", hellip: "\u2026",
  lsquo: "\u2018", rsquo: "\u2019", sbquo: "\u201a", ldquo: "\u201c", rdquo: "\u201d", bdquo: "\u201e",
  bull: "\u2022", trade: "\u2122", euro: "\u20ac", prime: "\u2032", Prime: "\u2033", larr: "\u2190", rarr: "\u2192",
};

// The Latin-1 named entities, in code point order from U+00A0: the accented letters and symbols that
// pages in most European languages use all the time.
const LATIN1_NAMES =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest " +
  "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig " +
  "agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";

const NAMED_ENTITIES: Record<string, string> = { ...PUNCTUATION_ENTITIES };
LATIN1_NAMES.split(" ").forEach((name, i) => {
  NAMED_ENTITIES[name] = name === "nbsp" ? " " : name === "shy" ? "" : String.fromCharCode(0xa0 + i);
});

/** Named (punctuation, and the Latin-1 set) and numeric entities, decoded in one pass so `&amp;lt;` stays `&lt;`. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g, (whole, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    const code = dec !== undefined ? Number(dec) : parseInt(hex as string, 16);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
    return String.fromCodePoint(code);
  });
}

/** Decodes entities, drops control and invisible formatting characters, and collapses whitespace to single spaces and single line breaks. */
export function normalizeText(raw: string): string {
  return decodeEntities(raw)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/\r\n?|\u2028|\u2029/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}

/** Cuts text to `max` characters (never in the middle of a character), and says whether it cut. */
export function cutText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { text: cut.trimEnd(), truncated: true };
}

const closerCache = new Map<string, RegExp>();
function closer(name: string): RegExp {
  let re = closerCache.get(name);
  if (!re) {
    re = new RegExp(`</${name}`, "gi");
    closerCache.set(name, re);
  }
  return re;
}

/** Index of the `>` that ends a tag whose attributes start at `from` (quotes after `=` are respected), or -1. */
function tagEnd(html: string, from: number): number {
  let quote = 0;
  let previous = 0; // the last character that was not whitespace
  for (let j = from; j < html.length; j += 1) {
    const c = html.charCodeAt(j);
    if (quote !== 0) {
      if (c === quote) quote = 0;
    } else if ((c === 34 || c === 39) && previous === 61) {
      quote = c;
    } else if (c === 62) {
      return j;
    }
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) previous = c;
  }
  return -1;
}

const NAME = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/y;

function titleOf(html: string): string | null {
  const open = /<title\b[^>]*>/i.exec(html);
  if (!open) return null;
  const from = open.index + open[0].length;
  const close = /<\/title/i.exec(html.slice(from, from + 1_000));
  const raw = html.slice(from, close ? from + close.index : from + 300);
  const title = normalizeText(raw).replace(/\n/g, " ");
  return title === "" ? null : title.slice(0, 300);
}

export interface Extracted {
  text: string;
  title: string | null;
  /** The text was cut at `maxChars`. */
  truncated: boolean;
}

export function extractText(html: string, maxChars: number): Extracted {
  const n = html.length;
  const main: string[] = [];
  const body: string[] = [];
  const stack: string[] = [];
  const counts = new Map<string, number>();
  let dropCount = 0;
  let mainCount = 0;
  let skipName: string | null = null;
  let skipDepth = 0;

  const put = (text: string) => {
    if (skipName !== null) return;
    if (dropCount === 0) body.push(text);
    if (mainCount > 0) main.push(text);
  };
  const pop = (name: string) => {
    if ((counts.get(name) ?? 0) === 0) return; // a stray closing tag
    while (stack.length > 0) {
      const top = stack.pop() as string;
      counts.set(top, (counts.get(top) ?? 1) - 1);
      if (DROP_OUTSIDE_MAIN.has(top)) dropCount -= 1;
      else mainCount -= 1;
      if (top === name) break;
    }
  };

  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      put(html.slice(i));
      break;
    }
    if (lt > i) put(html.slice(i, lt));
    i = lt;
    const next = html.charCodeAt(i + 1);

    if (next === 33 || next === 63) {
      if (html.startsWith("<!--", i)) {
        const end = html.indexOf("-->", i + 4);
        i = end === -1 ? n : end + 3;
      } else {
        const end = html.indexOf(">", i); // <!DOCTYPE ...>, <![CDATA[ ...>, <?xml ... ?>
        i = end === -1 ? n : end + 1;
      }
      continue;
    }

    NAME.lastIndex = i;
    const match = NAME.exec(html);
    if (!match) {
      if (next === 47) {
        const end = html.indexOf(">", i); // "</" with no name: a bogus comment
        i = end === -1 ? n : end + 1;
      } else {
        put("<"); // a lone "<" is text
        i += 1;
      }
      continue;
    }
    const closing = match[1] === "/";
    const name = match[2].toLowerCase();
    const end = tagEnd(html, i + match[0].length);
    if (end === -1) break; // the rest of the page is inside an unfinished tag
    const selfClosing = html.charCodeAt(end - 1) === 47;
    i = end + 1;

    if (skipName !== null) {
      if (skipName === "head" && !closing && name === "body") {
        skipName = null; // an unclosed <head> ends where <body> starts
      } else {
        if (name === skipName) {
          if (closing) skipDepth -= 1;
          else if (!selfClosing) skipDepth += 1;
          if (skipDepth === 0) skipName = null;
        }
        continue;
      }
    }

    if (!closing && SKIP_RAW.has(name)) {
      if (selfClosing) continue;
      const re = closer(name);
      re.lastIndex = i;
      const found = re.exec(html);
      if (!found) break; // unclosed script or style: the rest is code
      const closeEnd = html.indexOf(">", found.index + 2 + name.length);
      if (closeEnd === -1) break;
      i = closeEnd + 1;
      continue;
    }
    if (!closing && SKIP_NESTED.has(name)) {
      if (!selfClosing) {
        skipName = name;
        skipDepth = 1;
      }
      continue;
    }

    if (BLOCK.has(name)) put("\n");
    else if (CELL.has(name)) put(" ");
    if (DROP_OUTSIDE_MAIN.has(name) || MAIN_TAGS.has(name)) {
      if (closing) {
        pop(name);
      } else if (!selfClosing) {
        stack.push(name);
        counts.set(name, (counts.get(name) ?? 0) + 1);
        if (DROP_OUTSIDE_MAIN.has(name)) dropCount += 1;
        else mainCount += 1;
      }
    }
    if (closing && BLOCK.has(name)) put("\n");
  }

  const mainText = normalizeText(main.join(""));
  const bodyText = normalizeText(body.join(""));
  // Prefer <main>/<article>; fall back to the body when they hold little (an app shell with an empty <main>).
  const chosen = mainText.length >= MIN_MAIN_TEXT || mainText.length >= bodyText.length ? mainText : bodyText;
  const cut = cutText(chosen, maxChars);
  return { text: cut.text, title: titleOf(html), truncated: cut.truncated };
}

/** A password field on a page with little text: a sign-in page, not an article. */
export function looksLikeSignIn(html: string, text: string): boolean {
  if (text.length >= 1_500) return false;
  const inputs = /<input\b/gi;
  for (let seen = 0; seen < 200; seen += 1) {
    const found = inputs.exec(html);
    if (!found) return false;
    const chunk = html.slice(found.index, found.index + 1_500);
    const close = chunk.indexOf(">");
    if (/\btype\s*=\s*["']?\s*password\b/i.test(close === -1 ? chunk : chunk.slice(0, close))) return true;
  }
  return false;
}
