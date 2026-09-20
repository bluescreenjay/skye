import { describe, expect, it } from "vitest";
import { writeSimplePdf } from "@/src/actions/tools/pdf";

describe("simple pdf writer", () => {
  it("writes a header, xref, and the saved text", () => {
    const { bytes, replaced } = writeSimplePdf("Kyoto", "A short summary of the trip.");
    const text = Buffer.from(bytes).toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text).toContain("startxref");
    expect(text).toContain("%%EOF");
    expect(text).toContain("A short summary of the trip.");
    expect(replaced).toBe(false);
    const start = text.indexOf("startxref");
    const offset = Number(text.slice(start).split("\n")[1]);
    expect(Number.isFinite(offset)).toBe(true);
    expect(text.slice(offset).startsWith("xref")).toBe(true);
  });

  it("replaces non-Latin-1 characters with ?", () => {
    const { bytes, replaced } = writeSimplePdf("t", "こんにちは");
    expect(replaced).toBe(true);
    expect(Buffer.from(bytes).toString("latin1")).toContain("?");
  });
});
