import type { ChatHistoryPage, ChatStreamEvent } from "@ai-browser/shared";
import { requireUser } from "@/src/auth";
import { ChatError, friendlyLlmError, INTERRUPTED_MESSAGE, invalidCursor, invalidMessage, notAWorkspace, savedMessageOf, WorkspaceNotFoundError } from "@/src/chat/errors";
import { encodeEvent, streamHeaders } from "@/src/chat/events";
import { isLocked } from "@/src/chat/lock";
import { findWorkspace, historyPage, newestMessage } from "@/src/chat/messages";
import { beginReply, collectReply, type ReplyHandle } from "@/src/chat/send";
import { errorJson, json, optionsResponse } from "@/src/json";
import { BudgetExceededError, ModelError, ModelUnconfiguredError } from "@/src/llm/errors";

export const runtime = "nodejs";
// Above the 90 s cap on how long one reply may take.
export const maxDuration = 120;

export function OPTIONS() {
  return optionsResponse();
}

const chatErrorResponse = (error: ChatError, userMessage?: unknown) =>
  json({ error: error.message, code: error.code, ...error.extra, ...(userMessage ? { userMessage } : {}) }, error.status);

/** The signed-in user and the workspace id from the path, or the response to send instead (401, or 400 for the Other bucket). */
async function authorize(request: Request, context: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser(request);
  if (error) return { response: error };
  const { id } = await context.params;
  // "other" is what the sidebar uses for tabs with no workspace: chat belongs to a workspace.
  if (id === "other") return { response: chatErrorResponse(notAWorkspace()) };
  return { userId: user!.id, id };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorize(request, context);
  if (auth.response) return auth.response;
  const { userId, id } = auth;

  let body: { message?: unknown; retry?: unknown; stream?: unknown };
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return chatErrorResponse(invalidMessage());
    body = parsed as { message?: unknown; retry?: unknown; stream?: unknown };
  } catch {
    return chatErrorResponse(invalidMessage());
  }

  try {
    const handle = await beginReply(userId, id, { message: body.message, retry: body.retry, signal: request.signal });
    // Streaming is the default; `stream: false` waits for the whole reply and returns one JSON body.
    if (body.stream === false) return json(await collectReply(handle));
    return streamReply(handle, request.signal);
  } catch (caught) {
    if (caught instanceof WorkspaceNotFoundError) return errorJson("Workspace not found", 404);
    if (caught instanceof ChatError) return chatErrorResponse(caught, savedMessageOf(caught));
    if (caught instanceof ModelError || caught instanceof BudgetExceededError || caught instanceof ModelUnconfiguredError) {
      const friendly = friendlyLlmError(caught);
      const userMessage = savedMessageOf(caught);
      return json({ error: friendly.message, code: friendly.code, ...(userMessage ? { userMessage } : {}) }, friendly.status);
    }
    // Only the error's class name is logged: never a message, a tab, or a vendor body.
    console.error("chat failed:", caught instanceof Error ? caught.name : "unknown");
    return errorJson("Chat failed", 500);
  }
}

/**
 * The reply as an event stream. `beginReply` has already saved the person's message and the model
 * has already produced its first piece, so anything that failed before now was answered as plain
 * JSON. From here a failure can only end the stream with an `error` event, and the assistant
 * message is saved only after the last piece.
 */
function streamReply(handle: ReplyHandle, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let closed = false; // the client went away
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

  const send = (event: ChatStreamEvent) => {
    if (closed) return;
    try {
      controllerRef?.enqueue(encoder.encode(encodeEvent(event)));
    } catch {
      closed = true; // the stream was closed under us
    }
  };

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller;
      send({ event: "meta", data: { userMessage: handle.userMessage, contextInfo: handle.info } });
      send({ event: "delta", data: { text: handle.first } });
      let text = handle.first;
      try {
        for await (const piece of handle.rest) {
          text += piece;
          send({ event: "delta", data: { text: piece } });
        }
        if (closed || signal.aborted || handle.stopped) {
          handle.abandon(); // the client left: an unfinished reply is never saved
        } else {
          const assistantMessage = await handle.complete(text);
          send({ event: "done", data: { assistantMessage } });
        }
      } catch {
        // Any failure after the first piece ends the reply the same way: nothing is saved for it,
        // and the person retries. The cause is never sent.
        handle.abandon();
        send({ event: "error", data: { code: "interrupted", message: INTERRUPTED_MESSAGE } });
      }
      try {
        controller.close();
      } catch {
        // already closed by a cancel
      }
    },
    cancel() {
      closed = true;
      handle.abandon();
    },
  });

  return new Response(body, { status: 200, headers: streamHeaders() });
}

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

/** `limit`: 1 to 200; missing, not a number, or below 1 means 50. */
function pageSize(raw: string | null): number {
  const n = Math.floor(Number(raw));
  if (raw === null || raw.trim() === "" || !Number.isFinite(n) || n < 1) return DEFAULT_PAGE;
  return Math.min(n, MAX_PAGE);
}

/** The saved conversation. Makes no model call. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorize(request, context);
  if (auth.response) return auth.response;
  const { userId, id } = auth;

  const workspace = await findWorkspace(userId, id);
  if (!workspace) return errorJson("Workspace not found", 404);

  const url = new URL(request.url);
  const before = url.searchParams.get("before") ?? undefined;
  try {
    const page = await historyPage(userId, workspace.id, { limit: pageSize(url.searchParams.get("limit")), beforeId: before });
    if (!page) throw invalidCursor();
    const newest = await newestMessage(userId, workspace.id);
    const body: ChatHistoryPage = {
      messages: page.messages,
      hasMore: page.hasMore,
      replying: isLocked(userId, workspace.id),
      unansweredMessageId: newest?.role === "user" ? newest.id : null,
    };
    return json(body);
  } catch (caught) {
    if (caught instanceof ChatError) return chatErrorResponse(caught);
    console.error("chat history failed:", caught instanceof Error ? caught.name : "unknown");
    return errorJson("Chat failed", 500);
  }
}
