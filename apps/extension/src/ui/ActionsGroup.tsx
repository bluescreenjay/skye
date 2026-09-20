import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionSuggestion, BrowserIntent, ToolResult, ToolRunView } from "@ai-browser/shared";
import { loadConfig } from "../config";
import {
  ACTIONS_POLL_MS,
  cancelSend,
  confirmSend,
  intentsToExecute,
  isHttpsUrl,
  isValidRecipient,
  listActions,
  reportIntent,
  resultLines,
  runTool,
  shouldPoll,
  stableSwap,
  suggestActions,
  type IntentCounts,
} from "./actions";
import "./actions.css";

const UNREACHABLE = "could not reach the server";
const NO_CONFIG = "pairing failed — check your device token";

export interface ActionsGroupProps {
  workspaceId: string;
  onOpenTab: (url: string) => void;
  executeIntents: (intents: BrowserIntent[]) => Promise<IntentCounts>;
  onCopy?: (text: string) => void;
}

function latestFor(toolId: string, runs: ToolRunView[]): ToolRunView | undefined {
  return runs.find((run) => run.toolId === toolId);
}

function ResultText({ result, onOpenTab, onCopy }: { result: ToolResult; onOpenTab: (url: string) => void; onCopy?: (text: string) => void }) {
  switch (result.kind) {
    case "text":
    case "copy":
    case "summary":
      return (
        <>
          <p className="ax-text">{result.kind === "summary" ? result.text : result.text}</p>
          {result.kind === "copy" && onCopy ? (
            <button className="ax-retry" type="button" onClick={() => onCopy(result.text)}>
              Copy
            </button>
          ) : null}
        </>
      );
    case "file":
      return <p className="ax-text">{`${result.filename} (${result.bytes} bytes)`}</p>;
    case "opened":
      return <p className="ax-text">{`opened ${result.opened}; skipped ${result.skipped.length}; placed ${result.placed ?? 0}`}</p>;
    case "saved":
      return <p className="ax-text">{`saved ${result.added}; skipped ${result.skippedDuplicates}; refused ${result.refused}`}</p>;
    case "created":
      return <p className="ax-text">{`created ${result.what}`}</p>;
    case "search":
      return (
        <ul className="ax-list">
          {result.items.map((item, i) => (
            <li key={i}>{item.title}</li>
          ))}
        </ul>
      );
    case "mail_search":
      return <p className="ax-note">{`${result.shown} messages were shown; they are not kept`}</p>;
    case "email_preview":
      return (
        <div className="ax-mail">
          <p className="ax-text">{result.subject}</p>
          <p className="ax-text">{result.body}</p>
        </div>
      );
    default:
      return null;
  }
}

/**
 * Suggested actions for an expanded workspace card. Draws only the returned suggestions, never the
 * catalog. Polls GET /actions only while a run is going. Unreachable server: keep what is on screen.
 */
export function ActionsGroup({ workspaceId, onOpenTab, executeIntents, onCopy }: ActionsGroupProps) {
  const config = useMemo(() => loadConfig(import.meta.env), []);
  const [suggestions, setSuggestions] = useState<ActionSuggestion[]>([]);
  const [pendingNew, setPendingNew] = useState<ActionSuggestion[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [runs, setRuns] = useState<ToolRunView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [pressing, setPressing] = useState<ReadonlySet<string>>(new Set());
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  const [hovering, setHovering] = useState(false);
  const [recipient, setRecipient] = useState<Record<string, string>>({});
  const [mailByRun, setMailByRun] = useState<Record<string, { from: string; subject: string; date: string; excerpt: string }[]>>({});
  const started = useRef(new Set<string>());
  const executedIntents = useRef(new Set<string>());
  const alive = useRef(true);

  const applyRuns = useCallback((next: ToolRunView[] | null) => {
    if (next === null) {
      setUnreachable(true);
      return;
    }
    setUnreachable(false);
    setRuns(next);
  }, []);

  const loadSuggestions = useCallback(
    async (force: boolean) => {
      if (!config.ok) return;
      const set = await suggestActions(config.config, workspaceId, { force });
      if (!alive.current) return;
      if (!set) {
        setUnreachable(true);
        return;
      }
      setUnreachable(false);
      setNote(set.note);
      const swapped = stableSwap(suggestions, set.suggestions, hovering);
      if (swapped.offerNew) setPendingNew(set.suggestions);
      else {
        setSuggestions(swapped.suggestions);
        setPendingNew(null);
      }
    },
    [config, workspaceId, suggestions, hovering],
  );

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    setLoaded(false);
    setUnreachable(false);
    void (async () => {
      if (!config.ok) {
        setLoaded(true);
        return;
      }
      const [set, actions] = await Promise.all([
        suggestActions(config.config, workspaceId),
        listActions(config.config, workspaceId),
      ]);
      if (cancelled) return;
      setLoaded(true);
      if (!set || !actions) {
        setUnreachable(true);
        return;
      }
      setSuggestions(set.suggestions);
      setNote(set.note);
      setRuns(actions.runs);
    })();
    return () => {
      cancelled = true;
      alive.current = false;
    };
  }, [workspaceId, config]);

  const polling = config.ok && !unreachable && shouldPoll(runs);
  useEffect(() => {
    if (!polling || !config.ok) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void listActions(config.config, workspaceId).then((next) => {
        if (!cancelled) applyRuns(next?.runs ?? null);
      });
    }, ACTIONS_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [polling, runs, config, workspaceId, applyRuns]);

  useEffect(() => {
    if (!config.ok) return;
    for (const run of runs) {
      const intents = intentsToExecute(run, started.current).filter((intent) => !executedIntents.current.has(intent.id));
      if (intents.length === 0) continue;
      for (const intent of intents) executedIntents.current.add(intent.id);
      void executeIntents(intents).then((counts) => {
        for (const intent of intents) {
          void reportIntent(config.config, workspaceId, run.id, intent.id, {
            status: counts.opened > 0 || intent.kind === "download" ? "done" : "failed",
            opened: counts.opened,
            failed: counts.failed,
            placed: counts.placed,
          });
        }
      });
    }
  }, [runs, config, workspaceId, executeIntents]);

  const click = async (suggestion: ActionSuggestion) => {
    if (!config.ok || pressing.has(suggestion.toolId)) return;
    setPressing((current) => new Set(current).add(suggestion.toolId));
    setRefusals((current) => {
      const next = { ...current };
      delete next[suggestion.toolId];
      return next;
    });
    const outcome = await runTool(config.config, workspaceId, suggestion.toolId, {
      args: suggestion.args,
      label: suggestion.label,
    });
    if (!alive.current) return;
    setPressing((current) => {
      const next = new Set(current);
      next.delete(suggestion.toolId);
      return next;
    });
    if (outcome.kind === "started" || outcome.kind === "mail") {
      setUnreachable(false);
      started.current.add(outcome.run.id);
      setRuns((current) => [outcome.run, ...current.filter((run) => run.toolId !== outcome.run.toolId)]);
      if (outcome.kind === "mail" && Array.isArray(outcome.mail)) {
        setMailByRun((current) => ({ ...current, [outcome.run.id]: outcome.mail as { from: string; subject: string; date: string; excerpt: string }[] }));
      }
      if (outcome.run.state === "succeeded") void loadSuggestions(false);
    } else if (outcome.kind === "already_running") {
      const actions = await listActions(config.config, workspaceId);
      applyRuns(actions?.runs ?? null);
    } else if (outcome.kind === "refused") {
      setRefusals((current) => ({ ...current, [suggestion.toolId]: outcome.message }));
    } else {
      setUnreachable(true);
    }
  };

  const banner = !config.ok ? NO_CONFIG : unreachable ? UNREACHABLE : null;

  return (
    <div
      className="actions"
      onClick={(event) => event.stopPropagation()}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div className="ax-head">
        <span className="ax-name">actions</span>
        <button className="ax-retry" type="button" onClick={() => void loadSuggestions(true)}>
          refresh
        </button>
      </div>
      {banner ? (
        <p className="ax-note is-alert" role="status">
          {banner}
        </p>
      ) : null}
      {note && !banner ? <p className="ax-note">{note}</p> : null}
      {pendingNew ? (
        <button
          className="ax-retry"
          type="button"
          onClick={() => {
            setSuggestions(pendingNew);
            setPendingNew(null);
          }}
        >
          New suggestions
        </button>
      ) : null}
      {!loaded && config.ok ? <p className="ax-empty">loading…</p> : null}
      {suggestions.map((suggestion) => {
        const run = latestFor(suggestion.toolId, runs);
        const busy = run?.state === "running" || pressing.has(suggestion.toolId);
        const preview = run?.output?.result;
        const email = preview?.kind === "email_preview" ? preview : null;
        const to = recipient[run?.id ?? ""] ?? email?.to ?? "";
        return (
          <section className="ax-row" key={suggestion.id} aria-busy={busy}>
            <div className="ax-row-head">
              <div className="ax-title">
                <span className="ax-label">{suggestion.label}</span>
                <span className="ax-reason">{suggestion.reason}</span>
                {suggestion.preview.map((field) => (
                  <span className="ax-preview" key={field.name}>
                    {field.name}: {field.value}
                  </span>
                ))}
              </div>
              <button className="ax-run" type="button" disabled={busy} onClick={() => void click(suggestion)}>
                {busy ? "running…" : run?.state === "succeeded" ? "run again" : "run"}
              </button>
            </div>
            {run?.state === "running" ? <p className="ax-note">running</p> : null}
            {run?.state === "failed" && run.error ? (
              <p className="ax-note is-alert" role="status">
                {run.error.message}
              </p>
            ) : null}
            {refusals[suggestion.toolId] ? (
              <p className="ax-note is-alert" role="status">
                {refusals[suggestion.toolId]}
              </p>
            ) : null}
            {preview ? <ResultText result={preview} onOpenTab={onOpenTab} onCopy={onCopy} /> : null}
            {run?.output?.links.map((link, i) =>
              link.url && isHttpsUrl(link.url) ? (
                <button className="ax-link" type="button" key={`${link.url}-${i}`} onClick={() => onOpenTab(link.url!)}>
                  {link.label} {link.url}
                </button>
              ) : (
                <p className="ax-text" key={i}>
                  {link.label}
                  {link.id ? ` ${link.id}` : ""}
                </p>
              ),
            )}
            {email && run ? (
              <div className="ax-mail-actions">
                <label>
                  to
                  <input
                    value={to}
                    onChange={(event) => setRecipient((current) => ({ ...current, [run.id]: event.target.value }))}
                  />
                </label>
                <button
                  className="ax-run"
                  type="button"
                  disabled={!isValidRecipient(to) || email.state !== "unsent"}
                  onClick={() => {
                    if (!config.ok) return;
                    void confirmSend(config.config, workspaceId, run.id, to);
                  }}
                >
                  Send this message
                </button>
                <button
                  className="ax-retry"
                  type="button"
                  onClick={() => {
                    if (!config.ok) return;
                    void cancelSend(config.config, workspaceId, run.id);
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : null}
            {mailByRun[run?.id ?? ""]?.map((message, i) => (
              <p className="ax-text" key={i}>
                {message.from} · {message.subject} · {message.excerpt}
              </p>
            ))}
            {run && resultLines(run).length === 0 && run.state === "succeeded" ? <p className="ax-note">done</p> : null}
          </section>
        );
      })}
    </div>
  );
}
