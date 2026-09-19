// The lifecycle every provider's streaming call shares (specs/008-workspace-ai-chat/research.md
// section 2). A provider supplies three small things: how to send one attempt, what a
// non-200 answer means, and how to read text out of one `data:` payload. This file owns the
// rules that must be identical everywhere:
//
//  - every HTTP attempt is counted against the daily budget BEFORE it is sent;
//  - a slot from the local concurrency limiter is held for the WHOLE stream and always given back;
//  - a busy service is retried before the first piece arrives; after the first piece there is
//    NO retry (a second request would double-spend the allowance and could give another answer);
//  - a first-byte deadline of 25 s covers every attempt and any wait for a slot; a total cap of
//    90 s covers the whole stream;
//  - stopping (the caller's signal, or the consumer leaving) aborts the request and frees the slot;
//  - error messages are fixed and generic: never the prompt, message text, or a vendor body.
//    Nothing here logs.
import { spend, type Purpose } from "./budget";
import { BudgetExceededError, ModelError } from "./errors";
import { acquire } from "./limiter";
import { readDataLines } from "./sse";
import { DEADLINE_MS, isAbort, STREAM_TOTAL_MS, wait } from "./types";

/** What to do about a non-200 answer. */
export type Decision =
  /** At capacity: wait (the service's own hint, else backoff), then try again. */
  | { kind: "busy"; delayMs?: number }
  /** A hiccup on the service side: one more try, then give up. */
  | { kind: "retry_once" }
  | { kind: "fatal"; error: Error };

/** What one `data:` payload means. */
export interface Piece {
  text?: string;
  done?: boolean;
}

export interface StreamRequest {
  purpose: Purpose;
  /** The model id; requests for the same family share one pool of concurrency slots. */
  model: string;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Sends ONE attempt. `signal` aborts it. */
  send(signal: AbortSignal): Promise<Response>;
  /** Decides what a non-200 answer means (`text` is the response body, never shown to anyone). */
  classify(status: number, text: string): Decision;
  /** Reads one payload. May throw a `ModelError` for a payload it cannot read. */
  extract(payload: string): Piece;
}

const MAX_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;
const HICCUP_DELAY_MS = 1_000;

const BUSY = "The AI service is busy right now. Try again in a moment.";

export async function* runStream(request: StreamRequest): AsyncGenerator<string, void, void> {
  const sleep = request.sleep ?? wait;
  const controller = new AbortController();
  const stop = (reason?: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };

  const callerStopped = () => request.signal?.aborted === true;
  const onCallerAbort = () => stop(request.signal?.reason);
  if (callerStopped()) return; // nothing was started, nothing to clean up
  request.signal?.addEventListener("abort", onCallerAbort, { once: true });

  const totalTimer = setTimeout(() => stop(new DOMException("stream too long", "TimeoutError")), STREAM_TOTAL_MS);
  let firstByteTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => stop(new DOMException("no first piece in time", "TimeoutError")),
    DEADLINE_MS,
  );
  let release: (() => void) | undefined;
  let gotPiece = false;

  try {
    // ---- 1. Get a 200 response, retrying only what is transient.
    let response: Response | undefined;
    let lastBusy = false;
    let hiccups = 0;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !response; attempt += 1) {
      spend(request.purpose); // counts every attempt, including retries

      try {
        release = await acquire(request.model, controller.signal); // wait for a slot, never past the deadline
      } catch (error) {
        if (error instanceof BudgetExceededError) throw error;
        throw new ModelError("The AI service did not respond in time.");
      }

      let attemptResponse: Response;
      try {
        attemptResponse = await request.send(controller.signal);
      } catch (error) {
        release();
        release = undefined;
        if (callerStopped()) return;
        if (isAbort(error) || controller.signal.aborted) throw new ModelError("The AI service did not respond in time.");
        throw new ModelError();
      }

      if (attemptResponse.status === 200) {
        response = attemptResponse; // keep the slot: it is held until the stream ends
        break;
      }

      let text = "";
      try {
        text = await attemptResponse.text();
      } catch {
        // a body we cannot read is treated like an empty one
      }
      release();
      release = undefined;

      const decision = request.classify(attemptResponse.status, text);
      if (decision.kind === "fatal") throw decision.error;

      if (decision.kind === "busy") {
        lastBusy = true;
        const delay = decision.delayMs ?? Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
        try {
          await sleep(delay, controller.signal);
        } catch {
          break; // the deadline arrived while waiting
        }
        continue;
      }

      // retry_once
      lastBusy = false;
      hiccups += 1;
      if (hiccups > 1) throw new ModelError("The AI service is temporarily unavailable.");
      try {
        await sleep(HICCUP_DELAY_MS, controller.signal);
      } catch {
        break;
      }
    }
    if (!response) {
      if (callerStopped()) return;
      if (lastBusy) throw new BudgetExceededError(BUSY);
      throw new ModelError("The AI service did not respond in time.");
    }
    if (!response.body) throw new ModelError("The AI service returned an empty answer.");

    // ---- 2. Read the stream. From here on there is no retry.
    let ended = false;
    try {
      for await (const payload of readDataLines(response.body, controller.signal)) {
        const piece = request.extract(payload);
        if (piece.text) {
          if (!gotPiece) {
            gotPiece = true;
            clearTimeout(firstByteTimer); // the first-byte deadline has been met
            firstByteTimer = undefined;
          }
          yield piece.text;
        }
        if (piece.done) {
          ended = true;
          break;
        }
      }
    } catch (error) {
      if (callerStopped()) return;
      if (error instanceof ModelError || error instanceof BudgetExceededError) throw error;
      throw new ModelError(gotPiece ? "The AI service's answer was interrupted." : "The AI service did not respond in time.");
    }

    if (callerStopped()) return; // the consumer stopped us: not an error
    if (controller.signal.aborted && !ended) {
      // the first-byte deadline or the total cap ended the stream
      throw new ModelError(gotPiece ? "The AI service's answer was interrupted." : "The AI service did not respond in time.");
    }
    if (!gotPiece) throw new ModelError("The AI service returned an empty answer.");
  } finally {
    clearTimeout(totalTimer);
    if (firstByteTimer) clearTimeout(firstByteTimer);
    request.signal?.removeEventListener("abort", onCallerAbort);
    stop("finished"); // cancels the request and its body if either is still open
    release?.(); // the slot is always given back
  }
}
