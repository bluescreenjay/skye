// Tiny Latin-1 text PDF writer (one font, wrapped lines, pages, xref). No library.
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const FONT_SIZE = 11;
const LINE = 14;
const MAX_COLS = 80;

function latin1(text: string): { bytes: string; replaced: boolean } {
  let replaced = false;
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (char === "\\" || char === "(" || char === ")") {
      out += `\\${char}`;
    } else if (code >= 32 && code <= 255 && code !== 127) {
      out += code < 128 ? char : `\\${code.toString(8).padStart(3, "0")}`;
    } else if (char === "\n" || char === "\r" || char === "\t") {
      out += " ";
    } else {
      out += "?";
      replaced = true;
    }
  }
  return { bytes: out, replaced };
}

function wrap(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\n/)) {
    const words = raw.length === 0 ? [""] : raw.split(/\s+/);
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (next.length > MAX_COLS && current) {
        lines.push(current);
        current = word;
      } else current = next;
    }
    lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

export function writeSimplePdf(title: string, body: string): { bytes: Uint8Array; replaced: boolean } {
  const wrapped = wrap(`${title}\n\n${body}`);
  const perPage = Math.max(1, Math.floor((PAGE_H - MARGIN * 2) / LINE));
  const pages: string[][] = [];
  for (let i = 0; i < wrapped.length; i += perPage) pages.push(wrapped.slice(i, i + perPage));
  if (pages.length === 0) pages.push([""]);

  let replaced = false;
  const objects: string[] = [];
  const add = (bodyText: string) => {
    objects.push(bodyText);
    return objects.length;
  };

  const fontId = 0; // placeholders; rewritten after we know ids
  const pageIds: number[] = [];
  const contentIds: number[] = [];

  const catalogId = add("");
  const pagesId = add("");
  const fontObjId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");

  for (const pageLines of pages) {
    let stream = "BT /F1 11 Tf 14 TL\n";
    stream += `1 0 0 1 ${MARGIN} ${PAGE_H - MARGIN} Tm\n`;
    for (const line of pageLines) {
      const encoded = latin1(line);
      if (encoded.replaced) replaced = true;
      stream += `(${encoded.bytes}) Tj T*\n`;
    }
    stream += "ET";
    const content = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    contentIds.push(add(content));
    pageIds.push(add(""));
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  for (let i = 0; i < pageIds.length; i += 1) {
    objects[pageIds[i] - 1] =
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontObjId} 0 R >> >> /Contents ${contentIds[i]} 0 R >>`;
  }

  void fontId;
  const encoder = new TextEncoder();
  const header = "%PDF-1.4\n";
  const chunks: Uint8Array[] = [encoder.encode(header)];
  const offsets = [0];
  let offset = header.length;
  for (let i = 0; i < objects.length; i += 1) {
    const obj = `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    const bytes = encoder.encode(obj);
    offsets.push(offset);
    chunks.push(bytes);
    offset += bytes.length;
  }
  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(encoder.encode(xref));
  chunks.push(encoder.encode(trailer));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { bytes, replaced };
}
