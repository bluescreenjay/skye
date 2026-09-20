import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEntry, AgentResult, AgentRunView, PlanItem, WorkspaceAgents } from "@ai-browser/shared";
import { loadConfig, type Config } from "../config";
import { applyTick, describeCoverage, describeRunOutcome, nextPollMs, olderRuns, pressAgent, readAgents, readRuns, resultText, tickPlanItem } from "./agents";
import "./agents.css";

const UNREACHABLE = "could not reach the server";
const NO_CONFIG = "pairing failed — check your device token";

/** A run's time: just the time when it was today, the date too otherwise. */
function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
  if (at.toDateString() === new Date().toDateString()) return time;
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" }).toLowerCase()}, ${time}`;
}

/** The server's ticks that are still being saved win over what a poll reads back, so a tick never flickers off. */
function overlayTicks(items: PlanItem[], pending: Map<string, boolean>): PlanItem[] {
  let result = items;
  for (const [id, done] of pending) result = applyTick(result, id, done);
  return result;
}

interface ResultProps {
  run: AgentRunView;
  planItems: PlanItem[];
  onTick: (item: PlanItem, done: boolean) => void;
  onOpenTab: (url: string) => void;
}

/** A tab named in a result: its title as text, and a button that opens the person's own tab. Never a link, never loaded. */
function TabButton({ title, url, onOpenTab }: { title: string; url: string; onOpenTab: (url: string) => void }) {
  return (
    <button className="ag-link" type="button" title={url} onClick={() => onOpenTab(url)}>
      {title || url}
    </button>
  );
}

/**
 * One result, drawn as plain text elements only. Nothing in a result (a summary, a quote, a title, a
 * checklist item) is ever rendered as HTML or markdown, and nothing loads from a result's content.
 */
function ResultView({ run, planItems, onTick, onOpenTab }: ResultProps) {
  const output = run.output;
  if (!output) return null;
  const result: AgentResult = output.result;
  return (
    <div className="ag-result">
      {result.kind === "text" ? (
        <>
          <p className="ag-text">{result.text}</p>
          {result.cited.length > 0 ? (
            <p className="ag-from">
              from:{" "}
              {result.cited.map((tab, i) => (
                <span key={`${tab.url}-${i}`}>
                  {i > 0 ? ", " : ""}
                  <TabButton title={tab.title} url={tab.url} onOpenTab={onOpenTab} />
                </span>
              ))}
            </p>
          ) : null}
        </>
      ) : null}

      {result.kind === "comparison" ? (
        <>
          <div className="ag-table-wrap">
            <table className="ag-table">
              <thead>
                <tr>
                  <th />
                  {result.criteria.map((criterion, i) => (
                    <th key={i}>{criterion}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.options.map((option, row) => (
                  <tr key={row}>
                    <th scope="row">{option.tab ? <TabButton title={option.name} url={option.tab.url} onOpenTab={onOpenTab} /> : option.name}</th>
                    {result.criteria.map((_, col) => (
                      <td key={col}>{option.values[col] ?? ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.verdict ? <p className="ag-text">{result.verdict}</p> : null}
        </>
      ) : null}

      {result.kind === "checklist" ? (
        // Only the current checklist is tickable: it is the workspace's plan items, which the next run rewrites.
        planItems.length > 0 ? (
          <ul className="ag-checks">
            {planItems.map((item) => (
              <li key={item.id}>
                <label className={item.done ? "is-done" : undefined}>
                  <input type="checkbox" checked={item.done} onChange={(event) => onTick(item, event.target.checked)} />
                  <span>{item.text}</span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="ag-checks is-plain">
            {result.items.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
        )
      ) : null}

      {result.kind === "quotes" ? (
        <>
          {result.quotes.map((entry, i) => (
            <div className="ag-quote" key={i}>
              <p className="ag-text">“{entry.quote}”</p>
              <TabButton title={entry.tab.title} url={entry.tab.url} onOpenTab={onOpenTab} />
            </div>
          ))}
          {result.note ? <p className="ag-note">{result.note}</p> : null}
        </>
      ) : null}

      <p className="ag-coverage">
        {describeCoverage(output.sources, output.coverage)}
        {formatWhen(run.createdAt) ? ` · ${formatWhen(run.createdAt)}` : ""}
      </p>
    </div>
  );
}

/**
 * "earlier runs" of one agent: loads the stored runs the first time it is opened (and again if the agent's
 * newest run changes while it is open), and shows each older run's time, how it ended, and its result as
 * plain text. An older run is only ever text: even an older checklist has no boxes, because only the
 * current checklist (the workspace's plan items) can be ticked.
 */
function EarlierRuns({ config, workspaceId, agent }: { config: Config; workspaceId: string; agent: AgentEntry }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<{ runs: AgentRunView[]; hasMore: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const alive = useRef(true);
  // Changes whenever a run of this agent starts or finishes, so an open list never goes stale.
  const stamp = `${agent.latest?.id ?? ""}|${agent.lastFailed?.id ?? ""}|${agent.running?.id ?? ""}`;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false; // per run of this effect, not a shared ref (React may run effects twice)
    const reading = new AbortController();
    void readRuns(config, workspaceId, agent.id, { limit: 10 }, { signal: reading.signal }).then((next) => {
      if (cancelled) return;
      setFailed(next === null);
      if (next) setPage(next);
    });
    return () => {
      cancelled = true;
      reading.abort();
    };
  }, [open, stamp, config, workspaceId, agent.id]);

  const loadMore = async () => {
    const last = page?.runs[page.runs.length - 1];
    if (!page || !last || loadingMore) return;
    setLoadingMore(true);
    const next = await readRuns(config, workspaceId, agent.id, { limit: 10, before: last.id });
    if (!alive.current) return;
    setLoadingMore(false);
    if (next) setPage({ runs: [...page.runs, ...next.runs], hasMore: next.hasMore });
    else setFailed(true);
  };

  const runs = page ? olderRuns(agent, page.runs) : [];
  return (
    <div className="ag-earlier">
      <button className="ag-retry" type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        {open ? "hide earlier runs" : "earlier runs"}
      </button>
      {open ? (
        <div className="ag-old-list">
          {failed ? <p className="ag-note is-alert">could not load earlier runs</p> : null}
          {!failed && !page ? <p className="ag-empty">loading…</p> : null}
          {page && runs.length === 0 && !failed ? <p className="ag-empty">no earlier runs</p> : null}
          {runs.map((run) => (
            <div className="ag-old" key={run.id}>
              <p className="ag-old-head">
                {formatWhen(run.createdAt)} · {describeRunOutcome(run)}
              </p>
              {run.output ? resultText(run.output.result).map((line, i) => (
                <p className="ag-text" key={i}>
                  {line}
                </p>
              )) : null}
              {run.output ? <p className="ag-coverage">{describeCoverage(run.output.sources, run.output.coverage)}</p> : null}
            </div>
          ))}
          {page?.hasMore ? (
            <button className="ag-retry" type="button" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? "loading…" : "show more"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The agents of an expanded card (feature 010): each agent is a row with its name, description, a run
 * control, its state, and its latest result inline. It is mounted only while the card is open. It reads
 * the card once, then polls only while some agent is running, and stops on an unreachable server with one
 * plain note. Results are plain text only. `onOpenTab` is how the host opens one of the person's own tabs
 * (the card never opens an address itself).
 */
export function AgentsColumn({ workspaceId, onOpenTab }: { workspaceId: string; onOpenTab: (url: string) => void }) {
  const config = useMemo(() => loadConfig(import.meta.env), []);
  const [data, setData] = useState<WorkspaceAgents | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [pressing, setPressing] = useState<ReadonlySet<string>>(new Set());
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  const [tickNote, setTickNote] = useState<string | null>(null);
  const alive = useRef(true);
  const pendingTicks = useRef(new Map<string, boolean>());

  /** Shows a read, or (for a read that failed) keeps what is on screen and notes that the server is unreachable. */
  const apply = useCallback((next: WorkspaceAgents | null) => {
    if (next === null) {
      setUnreachable(true);
      return;
    }
    setUnreachable(false);
    setData({ agents: next.agents, planItems: overlayTicks(next.planItems, pendingTicks.current) });
  }, []);

  useEffect(() => {
    alive.current = true;
    // A flag per run, not the shared ref: React may mount, unmount, and mount again, and the first run's
    // late answer must not be applied after the second has started.
    let cancelled = false;
    const opened = new AbortController();
    setData(null);
    setLoaded(false);
    setUnreachable(false);
    setRefusals({});
    void (async () => {
      const next = config.ok ? await readAgents(config.config, workspaceId, { signal: opened.signal }) : null;
      if (cancelled) return;
      setLoaded(true);
      apply(next);
    })();
    return () => {
      cancelled = true;
      alive.current = false;
      opened.abort();
    };
  }, [workspaceId, config, apply]);

  // Poll only while some agent is running; a new read re-arms the timer, so it stops on its own when none is.
  const delay = data && !unreachable ? nextPollMs(data.agents) : null;
  useEffect(() => {
    if (delay === null || !config.ok) return;
    let cancelled = false;
    const polling = new AbortController();
    const timer = setTimeout(() => {
      void readAgents(config.config, workspaceId, { signal: polling.signal }).then((next) => {
        if (!cancelled) apply(next);
      });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      polling.abort();
    };
  }, [delay, data, config, workspaceId, apply]);

  const reload = async () => {
    if (!config.ok) return;
    const next = await readAgents(config.config, workspaceId);
    if (!alive.current) return;
    apply(next);
    if (next !== null) setTickNote(null); // the person asked again and it worked: an old "could not save" note is stale
  };

  const press = async (agent: AgentEntry) => {
    if (!config.ok || pressing.has(agent.id)) return;
    setPressing((current) => new Set(current).add(agent.id));
    setRefusals((current) => {
      const next = { ...current };
      delete next[agent.id];
      return next;
    });
    const outcome = await pressAgent(config.config, workspaceId, agent.id);
    if (!alive.current) return;
    setPressing((current) => {
      const next = new Set(current);
      next.delete(agent.id);
      return next;
    });
    if (outcome.kind === "started") {
      setUnreachable(false);
      setData((current) => current && { ...current, agents: current.agents.map((a) => (a.id === agent.id ? { ...a, running: outcome.run } : a)) });
    } else if (outcome.kind === "already_running") {
      await reload(); // it is running: show the true state, not an error
    } else if (outcome.kind === "refused") {
      setRefusals((current) => ({ ...current, [agent.id]: outcome.message }));
    } else {
      setUnreachable(true);
    }
  };

  const tick = async (item: PlanItem, done: boolean) => {
    if (!config.ok) return;
    pendingTicks.current.set(item.id, done);
    setTickNote(null);
    setData((current) => current && { ...current, planItems: applyTick(current.planItems, item.id, done) });
    const saved = await tickPlanItem(config.config, workspaceId, item.id, done);
    const stillMine = pendingTicks.current.get(item.id) === done; // the person may have ticked it again meanwhile
    if (stillMine) pendingTicks.current.delete(item.id);
    if (!alive.current || saved || !stillMine) return;
    // Not saved: put the box back exactly as it was, and say so.
    setData((current) => current && { ...current, planItems: applyTick(current.planItems, item.id, item.done) });
    setTickNote("could not save that tick — it was put back");
  };

  const note = !config.ok ? NO_CONFIG : unreachable ? UNREACHABLE : null;

  return (
    <div className="agents" onClick={(event) => event.stopPropagation()}>
      {note ? (
        <p className="ag-note is-alert" role="status">
          {note}
          {config.ok ? (
            <button className="ag-retry" type="button" onClick={() => void reload()}>
              try again
            </button>
          ) : null}
        </p>
      ) : null}
      {!loaded && config.ok ? <p className="ag-empty">loading…</p> : null}
      {tickNote ? (
        <p className="ag-note is-alert" role="status">
          {tickNote}
        </p>
      ) : null}
      {data?.agents.map((agent) => {
        const running = agent.running !== null;
        const busy = running || pressing.has(agent.id);
        const refusal = refusals[agent.id];
        return (
          <section className="ag-row" key={agent.id} aria-busy={busy}>
            <div className="ag-head">
              <div className="ag-title">
                <span className="ag-name">{agent.name}</span>
                <span className="ag-desc">{agent.description}</span>
              </div>
              <button className="ag-run" type="button" disabled={busy} onClick={() => void press(agent)}>
                {busy ? "running…" : agent.latest || agent.lastFailed ? "run again" : "run"}
              </button>
            </div>
            {agent.lastFailed && agent.lastFailed.error ? (
              <p className="ag-note is-alert" role="status">
                {agent.lastFailed.error.message}
              </p>
            ) : null}
            {refusal ? (
              <p className="ag-note is-alert" role="status">
                {refusal}
              </p>
            ) : null}
            {agent.latest ? <ResultView run={agent.latest} planItems={data.planItems} onTick={(item, done) => void tick(item, done)} onOpenTab={onOpenTab} /> : null}
            {config.ok && (agent.latest || agent.lastFailed) ? <EarlierRuns config={config.config} workspaceId={workspaceId} agent={agent} /> : null}
          </section>
        );
      })}
    </div>
  );
}
