import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { loadConfig } from "../config";
import { contextLabel, readHistory, sendChat, statusMessage, toLines, type ChatLine } from "./chat";

const MAX_MESSAGE = 4000; // the server's limit, in characters

interface Note {
  text: string;
  /** True when the person's last message is saved without an answer, so Retry makes sense. */
  retry: boolean;
}

/**
 * The "ask the workspace anything" panel of an expanded card, backed by feature 008's chat API.
 * It is mounted only while the card is open. Closing the card stops a reply that is still being
 * written (the person's message stays saved, and Retry is offered next time). Reply text is
 * rendered as plain text only: never as HTML, links, or images.
 */
export function WorkspaceChat({ workspaceId }: { workspaceId: string }) {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [basis, setBasis] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const running = useRef<AbortController | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    // A flag per run, not the shared ref: React may mount, unmount, and mount again, and the
    // first run's late answer must not be applied after the second has started.
    let cancelled = false;
    const opened = new AbortController();
    void (async () => {
      const result = loadConfig(import.meta.env);
      const page = result.ok ? await readHistory(result.config, workspaceId, { signal: opened.signal }) : null;
      if (cancelled) return;
      setLoaded(true);
      if (!page) {
        setNote({ text: result.ok ? "could not load this conversation" : statusMessage(401), retry: false });
        return;
      }
      setLines(toLines(page.messages));
      if (page.replying) {
        setBusy(true);
        setNote({ text: "an answer is still being written — close and reopen this card in a moment", retry: false });
      } else if (page.unansweredMessageId) {
        setNote({ text: "your last question has no answer yet", retry: true });
      }
    })();
    return () => {
      cancelled = true;
      alive.current = false;
      opened.abort();
      running.current?.abort(); // a reply still being written is stopped; the message stays saved
    };
  }, [workspaceId]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [lines, busy]);

  const run = useCallback(
    async (input: { message: string } | { retry: true }) => {
      const result = loadConfig(import.meta.env);
      if (!result.ok) {
        setNote({ text: statusMessage(401), retry: false });
        return;
      }
      const controller = new AbortController();
      running.current = controller;
      const stamp = Date.now();
      const localId = `local-you-${stamp}`;
      const replyId = `local-skye-${stamp}`;
      const isMessage = "message" in input;

      setBusy(true);
      setNote(null);
      if (isMessage) setLines((current) => [...current, { id: localId, who: "you", text: input.message }]);

      const outcome = await sendChat(
        result.config,
        workspaceId,
        input,
        {
          onMeta: ({ userMessage, contextInfo }) => {
            if (!alive.current) return;
            setBasis(contextLabel(contextInfo));
            setLines((current) =>
              current.some((line) => line.id === userMessage.id)
                ? current
                : current.map((line) => (line.id === localId ? { ...line, id: userMessage.id } : line)),
            );
          },
          onDelta: (text) => {
            if (!alive.current) return;
            setLines((current) => {
              const at = current.findIndex((line) => line.id === replyId);
              if (at < 0) return [...current, { id: replyId, who: "skye", text }];
              const next = current.slice();
              next[at] = { ...next[at], text: next[at].text + text };
              return next;
            });
          },
        },
        { signal: controller.signal },
      );

      if (running.current === controller) running.current = null;
      if (!alive.current || outcome.kind === "aborted") return;
      setBusy(false);

      if (outcome.kind === "done") {
        setLines((current) =>
          current.map((line) =>
            line.id === replyId ? { id: outcome.assistantMessage.id, who: "skye", text: outcome.assistantMessage.content } : line,
          ),
        );
        return;
      }

      // A reply that did not finish is never shown as if it had: the partial text goes away.
      setLines((current) => current.filter((line) => line.id !== replyId));
      const saved = outcome.userMessage;
      if (outcome.kind === "interrupted") {
        setNote({ text: "the answer was interrupted — your message is saved", retry: true });
        return;
      }
      if (saved) {
        setLines((current) => current.map((line) => (line.id === localId ? { ...line, id: saved.id } : line)));
      } else if (isMessage) {
        // Nothing was saved: take the row back and give the person their text again.
        setLines((current) => current.filter((line) => line.id !== localId));
        setDraft(input.message);
      }
      setNote({ text: outcome.message, retry: saved !== null });
    },
    [workspaceId],
  );

  const send = () => {
    const message = draft.trim();
    if (!message || busy) return;
    setDraft("");
    void run({ message });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  const waiting = busy && lines[lines.length - 1]?.who === "you";

  return (
    <div className="chat" onClick={(event) => event.stopPropagation()}>
      <div className="chat-log" ref={logRef}>
        {loaded && lines.length === 0 ? <div className="chat-empty">nothing asked yet</div> : null}
        {lines.map((line) => (
          <div key={line.id} className={`chat-msg is-${line.who}`}>
            <span className="chat-who">{line.who}</span>
            <p className="chat-text">{line.text}</p>
          </div>
        ))}
        {waiting ? <div className="chat-empty">thinking…</div> : null}
      </div>
      {note ? (
        <p className="chat-note is-alert" role="status">
          {note.text}
          {note.retry && !busy ? (
            <button className="chat-retry" type="button" onClick={() => void run({ retry: true })}>
              retry
            </button>
          ) : null}
        </p>
      ) : basis ? (
        <p className="chat-note">{basis}</p>
      ) : null}
      <input
        className="ask"
        type="text"
        placeholder="ask the workspace anything"
        spellCheck={false}
        autoComplete="off"
        maxLength={MAX_MESSAGE}
        value={draft}
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
