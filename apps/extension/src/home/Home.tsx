import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import type { TabRef, Workspace } from "@ai-browser/shared";
import { TabMark } from "../ui/TabMark";
import { TabRow } from "../ui/TabRow";
import { loadDirectory, moveTab, renameWorkspace, runCluster } from "./api";
import { composeDirectory, type HomeDirectory } from "./compose";
import { openHomeTab } from "./navigation";
import type { OrganizeStatus } from "./organize";
import { loadWeatherPhrase } from "./weather";
import { WorkspaceChat } from "./WorkspaceChat";
import { createPairingOffer, loadDevices, revokeDevice } from "./pairing";
import type { Device } from "@ai-browser/shared";

const ACTIONS = ["summarize", "collect refs", "new artifact"] as const;

function formatTime(): string {
  return new Date()
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .toLowerCase();
}

function workHint(cards: HomeDirectory["cards"]): string {
  const names = cards.slice(0, 3).map((card) => card.workspace.name.replace(/\s+/g, " ").toLowerCase());
  if (names.length === 0) return "quiet for now";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]}, and ${names[2]}`;
}

function greetingText(weather: string, cards: HomeDirectory["cards"]): string {
  return `hi. it's ${formatTime()} and the weather where you are is ${weather}. some trends in your browsing tabs are ${workHint(cards)}. what will you get done today?`;
}

export function Home() {
  const [directory, setDirectory] = useState<HomeDirectory>({ other: [], cards: [] });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [weather, setWeather] = useState("checking");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [organizeStatus, setOrganizeStatus] = useState<OrganizeStatus>("idle");
  const [organizeMessage, setOrganizeMessage] = useState("");
  const [directoryReady, setDirectoryReady] = useState(false);
  const [correctionNote, setCorrectionNote] = useState("");
  const [enterMotion, setEnterMotion] = useState(true);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [offer, setOffer] = useState<{ code: string; expiresAt: string; qrUrl: string } | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [pairingMessage, setPairingMessage] = useState("");
  const suppressClicksUntil = useRef(0);
  const dragId = useRef<string | null>(null);
  const dragRaf = useRef<number | null>(null);
  const organizing = useRef(false);

  const refresh = useCallback(async () => {
    const { workspaces, tabRefs } = await loadDirectory();
    setDirectory(composeDirectory(workspaces, tabRefs));
    setDirectoryReady(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void loadWeatherPhrase().then(setWeather);
  }, []);

  const refreshDevices = useCallback(() => {
    void loadDevices().then(setDevices);
  }, []);

  const startPairing = () => {
    setPairingMessage("");
    void createPairingOffer().then((next) => {
      if (!next) { setPairingMessage("could not create a pairing code"); return; }
      setOffer(next);
      refreshDevices();
    }).catch(() => setPairingMessage("could not create a pairing code"));
  };

  const togglePairing = () => {
    setPairingOpen((open) => !open);
    if (!pairingOpen) { refreshDevices(); if (!offer) startPairing(); }
  };

  // Entrance animations must not stay on forever — re-renders during drag were
  // restarting rail-icon keyframes and looking like a glitch from Other.
  useEffect(() => {
    const timer = window.setTimeout(() => setEnterMotion(false), 900);
    return () => window.clearTimeout(timer);
  }, []);

  const onOrganize = () => {
    if (!directoryReady || organizing.current || organizeStatus === "running") return;
    organizing.current = true;
    setOrganizeStatus("running");
    setOrganizeMessage("organizing…");
    void (async () => {
      try {
        const outcome = await runCluster();
        setOrganizeStatus(outcome.status);
        setOrganizeMessage(outcome.message);
        if (outcome.shouldRefresh) {
          await refresh();
        }
      } finally {
        organizing.current = false;
      }
    })();
  };

  const afterDragClick = (event: { preventDefault(): void; stopPropagation(): void }): boolean => {
    // Only suppress the synthetic click right after a finished drag — never latch
    // a sticky flag on dragStart (that left Home unable to open tabs).
    if (Date.now() >= suppressClicksUntil.current) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  const endDrag = () => {
    if (dragRaf.current != null) {
      cancelAnimationFrame(dragRaf.current);
      dragRaf.current = null;
    }
    dragId.current = null;
    setDraggingId(null);
    setDropTarget(null);
    suppressClicksUntil.current = Date.now() + 200;
  };

  const onDragStart = (tabId: string) => (event: DragEvent) => {
    dragId.current = tabId;
    event.dataTransfer.setData("text/plain", tabId);
    event.dataTransfer.effectAllowed = "move";
    if (dragRaf.current != null) cancelAnimationFrame(dragRaf.current);
    // Defer dimming so React does not replace the drag source mid-start.
    dragRaf.current = requestAnimationFrame(() => {
      dragRaf.current = null;
      setDraggingId(tabId);
    });
  };

  const onDragEnd = () => {
    endDrag();
  };

  const destinationFromTarget = (target: string): string | null => (target === "ungrouped" ? null : target);

  const onDrop = (target: string) => (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const tabId = event.dataTransfer.getData("text/plain") || dragId.current;
    endDrag();
    if (!tabId) return;
    const workspaceId = destinationFromTarget(target);
    const previous = directory;
    setDirectory((current) => {
      const all = [...current.other, ...current.cards.flatMap((card) => card.tabs)];
      const tab = all.find((item) => item.id === tabId);
      if (!tab || tab.workspaceId === workspaceId) return current;
      return composeDirectory(
        current.cards.map((card) => card.workspace),
        all.map((item) => (item.id === tabId ? { ...item, workspaceId } : item)),
      );
    });
    setCorrectionNote("");
    void moveTab(tabId, workspaceId).then((saved) => {
      if (!saved) {
        setDirectory(previous);
        setCorrectionNote("could not save that move");
        return;
      }
    });
  };

  const bindDrop = (target: string) => ({
    onDragOver: (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setDropTarget((current) => (current === target ? current : target));
    },
    onDrop: onDrop(target),
  });

  const openTab = (tab: TabRef) => (event: MouseEvent) => {
    event.stopPropagation();
    if (afterDragClick(event)) return;
    void openHomeTab(tab);
  };

  const toggleCard = (workspaceId: string) => (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest(".ws-name, .app-icon")) return;
    if (afterDragClick(event)) return;
    setExpandedId((current) => (current === workspaceId ? null : workspaceId));
  };

  const commitRename = async (workspace: Workspace, next: string) => {
    const name = next.trim().toLowerCase();
    if (name.length < 1 || name.length > 80 || name === workspace.name) return;
    const previous = directory;
    setDirectory((current) => ({
      ...current,
      cards: current.cards.map((card) =>
        card.workspace.id === workspace.id
          ? { ...card, workspace: { ...card.workspace, name } }
          : card,
      ),
    }));
    setCorrectionNote("");
    const saved = await renameWorkspace(workspace.id, name);
    if (!saved) {
      setDirectory(previous);
      setCorrectionNote("could not rename that workspace");
      return;
    }
  };

  return (
    <div id="app" className={`app${enterMotion ? " view-enter" : ""}`} data-view="home">
      <aside className="rail" aria-label="icon rail">
        <div
          className={`rail-section rail-ungrouped${dropTarget === "ungrouped" ? " is-drop" : ""}`}
          {...bindDrop("ungrouped")}
        >
          {directory.other.map((tab) => (
            <button
              key={tab.id}
              className={`rail-icon${draggingId === tab.id ? " is-dragging" : ""}`}
              type="button"
              title={tab.title.toLowerCase()}
              draggable
              onDragStart={onDragStart(tab.id)}
              onDragEnd={onDragEnd}
              onClick={openTab(tab)}
            >
              <TabMark url={tab.url} title={tab.title} size={28} />
            </button>
          ))}
        </div>
        <div className="rail-divider" />
        <div className="rail-section rail-saved">
          {directory.cards.map((card) => (
            <button
              key={card.workspace.id}
              className={`group-tile${dropTarget === card.workspace.id ? " is-drop" : ""}${expandedId === card.workspace.id ? " is-selected" : ""}`}
              type="button"
              title={card.workspace.name.toLowerCase()}
              onClick={(event) => {
                if (afterDragClick(event)) return;
                setExpandedId((current) =>
                  current === card.workspace.id ? null : card.workspace.id,
                );
              }}
              {...bindDrop(card.workspace.id)}
            >
              {card.tabs.slice(0, 4).map((tab) => (
                <TabMark key={tab.id} url={tab.url} title={tab.title} size={16} />
              ))}
            </button>
          ))}
        </div>
      </aside>
      <main className="home">
        <div className="home-top">
          <p className="wordmark">skye</p>
          <input className="url-bar" type="text" placeholder="url bar" spellCheck={false} autoComplete="off" />
          <p className="greeting">{greetingText(weather, directory.cards)}</p>
        </div>
        <div className="organize-row">
          <button
            type="button"
            className="organize-btn"
            disabled={!directoryReady || organizeStatus === "running"}
            onClick={onOrganize}
          >
            organize
          </button>
          {organizeMessage ? (
            <p
              className={`organize-status${
                organizeStatus === "failed" || organizeStatus === "empty" ? ` is-${organizeStatus}` : ""
              }`}
              role="status"
            >
              {organizeMessage}
            </p>
          ) : null}
          {correctionNote ? (
            <p className="organize-status is-failed" role="status">
              {correctionNote}
            </p>
          ) : null}
          <button type="button" className="organize-btn pairing-btn" onClick={togglePairing}>pair phone</button>
        </div>
        {pairingOpen ? <PairingPanel offer={offer} devices={devices} message={pairingMessage} onNewCode={startPairing} onRevoke={async (id) => { if (await revokeDevice(id)) refreshDevices(); }} /> : null}
        {directory.cards.map((card) => (
          <WorkspaceCardView
            key={card.workspace.id}
            card={card}
            expanded={expandedId === card.workspace.id}
            dropTarget={dropTarget}
            draggingId={draggingId}
            bindDrop={bindDrop}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onToggle={toggleCard(card.workspace.id)}
            onOpenTab={openTab}
            onRename={commitRename}
          />
        ))}
      </main>
    </div>
  );
}

function PairingPanel({ offer, devices, message, onNewCode, onRevoke }: { offer: { code: string; expiresAt: string; qrUrl: string } | null; devices: Device[]; message: string; onNewCode: () => void; onRevoke: (id: string) => void }) {
  const phones = devices.filter((device) => device.kind === "mobile" && !device.revokedAt);
  return <section className="pairing-panel">
    <div><p className="pairing-title">pair your phone</p>{offer ? <><code className="pairing-code">{offer.code}</code><p className="pairing-copy">Enter this code at the companion, or open <a href={offer.qrUrl} target="_blank" rel="noreferrer">this pairing link</a>. Expires {new Date(offer.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.</p></> : <p className="pairing-copy">Creating a short-lived code…</p>}{message ? <p className="pairing-copy">{message}</p> : null}<button type="button" className="btn" onClick={onNewCode}>new code</button></div>
    <div><p className="pairing-title">paired phones</p>{phones.length ? phones.map((device) => <div className="paired-device" key={device.id}><span>{device.label || "Mobile companion"}</span><button className="btn" type="button" onClick={() => onRevoke(device.id)}>revoke</button></div>) : <p className="pairing-copy">No phones paired yet.</p>}</div>
  </section>;
}

function WorkspaceCardView({
  card,
  expanded,
  dropTarget,
  draggingId,
  bindDrop,
  onDragStart,
  onDragEnd,
  onToggle,
  onOpenTab,
  onRename,
}: {
  card: HomeDirectory["cards"][number];
  expanded: boolean;
  dropTarget: string | null;
  draggingId: string | null;
  bindDrop: (target: string) => {
    onDragOver: (event: DragEvent) => void;
    onDrop: (event: DragEvent) => void;
  };
  onDragStart: (tabId: string) => (event: DragEvent) => void;
  onDragEnd: () => void;
  onToggle: (event: MouseEvent) => void;
  onOpenTab: (tab: TabRef) => (event: MouseEvent) => void;
  onRename: (workspace: Workspace, next: string) => Promise<void>;
}) {
  const name = card.workspace.name.toLowerCase();

  return (
    <article
      className={`card${expanded ? " is-open" : ""}${dropTarget === card.workspace.id ? " is-drop" : ""}`}
      data-id={card.workspace.id}
      {...bindDrop(card.workspace.id)}
    >
      <div className="card-head" onClick={onToggle}>
        <NameEditor
          name={name}
          onCommit={(next) => void onRename(card.workspace, next)}
        />
        <div className="card-icons">
          {card.tabs.map((tab) => (
            <span
              key={tab.id}
              className={`app-icon${draggingId === tab.id ? " is-dragging" : ""}`}
              data-id={tab.id}
              draggable
              onDragStart={onDragStart(tab.id)}
              onDragEnd={onDragEnd}
              onClick={onOpenTab(tab)}
            >
              <TabMark url={tab.url} title={tab.title} size={22} />
            </span>
          ))}
        </div>
      </div>
      {expanded ? (
        <div className="card-thirds">
          <div className="band">
            {card.tabs.map((tab) => (
              <TabRow
                key={tab.id}
                tab={tab}
                className={`is-entering${draggingId === tab.id ? " is-dragging" : ""}`}
                draggable
                onDragStart={onDragStart(tab.id)}
                onDragEnd={onDragEnd}
                onClick={onOpenTab(tab)}
              />
            ))}
          </div>
          <div className="band band-actions">
            <div className="actions">
              {ACTIONS.map((label) => (
                <button
                  key={label}
                  className="btn"
                  type="button"
                  onClick={(event) => event.stopPropagation()}
                >
                  {label}
                </button>
              ))}
            </div>
            <WorkspaceChat workspaceId={card.workspace.id} />
          </div>
          <div className="band band-artifacts">
            <div className="empty">no artifacts yet</div>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function NameEditor({ name, onCommit }: { name: string; onCommit: (next: string) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const editing = useRef(false);

  useEffect(() => {
    if (editing.current || !ref.current) return;
    ref.current.textContent = name;
  }, [name]);

  return (
    <span
      ref={ref}
      className="ws-name"
      suppressContentEditableWarning
      onClick={(event) => {
        event.stopPropagation();
        const node = ref.current;
        if (!node) return;
        editing.current = true;
        node.contentEditable = "true";
        node.focus();
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        (event.currentTarget as HTMLSpanElement).blur();
      }}
      onBlur={(event) => {
        editing.current = false;
        event.currentTarget.contentEditable = "false";
        const next = (event.currentTarget.textContent ?? "").trim().toLowerCase();
        if (next.length < 1 || next.length > 80) {
          event.currentTarget.textContent = name;
          return;
        }
        onCommit(next);
      }}
    />
  );
}
