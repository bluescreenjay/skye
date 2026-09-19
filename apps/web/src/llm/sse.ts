// Reads a server-sent-events body as a sequence of `data:` payloads. Both providers stream
// this way (OpenAI-style `data: {...}` lines ending in `data: [DONE]`, and Gemini's
// `alt=sse`). It only cares about `data:` lines; `event:`, comments (`:`), and blank
// lines are skipped. Network chunks can split a line, or even a multi-byte character, anywhere.

/** The payload of a `data:` line (one optional space after the colon removed), or undefined for any other line. */
function payloadOf(line: string): string | undefined {
  if (!line.startsWith("data:")) return undefined;
  const payload = line.slice(5);
  return payload.startsWith(" ") ? payload.slice(1) : payload;
}

/**
 * Yields each `data:` payload as it arrives. Stops when the stream ends or `signal`
 * aborts, and always cancels the underlying reader so a connection is never left open.
 */
export async function* readDataLines(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let finished = false;

  const cancel = () => {
    reader.cancel().catch(() => undefined);
  };
  if (signal?.aborted) {
    cancel();
    return;
  }
  signal?.addEventListener("abort", cancel, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode(); // flush a character that was split at the very end

      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        const payload = payloadOf(line);
        if (payload !== undefined) yield payload;
      }
      if (done) {
        finished = true;
        const last = payloadOf(buffer.replace(/\r$/, ""));
        if (last !== undefined) yield last; // a final line with no trailing newline
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!finished) await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // a read may still be pending after an abort; the reader is already cancelled
    }
  }
}
