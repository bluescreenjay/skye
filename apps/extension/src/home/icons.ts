const PALETTE_SIZE = 6;

export interface LetterMark {
  letter: string;
  hue: number;
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function hashHue(value: string): number {
  let hash = 0;
  for (const ch of value) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash;
}

/** Colored letter mark from hostname or title. No brand PNG pack required. */
export function markFromTab(url: string, title: string): LetterMark {
  const host = hostFromUrl(url);
  const source = host || title.trim() || "?";
  const letter = (source.replace(/[^a-z0-9]/gi, "")[0] || "?").toLowerCase();
  return { letter, hue: hashHue(source) % PALETTE_SIZE };
}
