import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import type { TabRef, Workspace } from "@ai-browser/shared";
import { loadDirectory, moveTab, renameWorkspace } from "./api";
import { composeDirectory, type HomeDirectory } from "./compose";
import { markFromTab } from "./icons";
import { loadWeatherPhrase } from "./weather";

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

function Mark({ url, title, size }: { url: string; title: string; size: 16 | 22 | 28 }) {
  const { letter, hue } = markFromTab(url, title);
  return (
    <span className={`mark mark-letter sz-${size} mark-h${hue}`} aria-hidden>
      {letter}
    </span>
  );
}

function openTabUrl(url: string): void {
  try {
    void chrome.tabs.create({ url });
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

export function Home() {
  const [directory, setDirectory] = useState<HomeDirectory>({ other: [], cards: [] });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [weather, setWeather] = useState("checking");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const ignoreClick = useRef(false);
  const dragId = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const { workspaces, tabRefs } = await loadDirectory();
    setDirectory(composeDirectory(workspaces, tabRefs));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void loadWeatherPhrase().then(setWeather);
  }, []);

  const afterDragClick = (event: { preventDefault(): void; stopPropagation(): void }): boolean => {
    if (!ignoreClick.current) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  const onDragStart = (tabId: string) => (event: DragEvent) => {
    dragId.current = tabId;
    setDraggingId(tabId);
    ignoreClick.current = true;
    event.dataTransfer.setData("text/plain", tabId);
    event.dataTransfer.effectAllowed = "move";
  };

  const onDragEnd = () => {
    dragId.current = null;
    setDraggingId(null);
    setDropTarget(null);
    window.setTimeout(() => {
      ignoreClick.current = false;
    }, 60);
  };

  const destinationFromTarget = (target: string): string | null => (target === "ungrouped" ? null : target);

  const onDrop = (target: string) => (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const tabId = event.dataTransfer.getData("text/plain") || dragId.current;
    setDropTarget(null);
    if (!tabId) return;
    const workspaceId = destinationFromTarget(target);
    setDirectory((current) => {
      const all = [...current.other, ...current.cards.flatMap((card) => card.tabs)];
      const tab = all.find((item) => item.id === tabId);
      if (!tab || tab.workspaceId === workspaceId) return current;
      return composeDirectory(
        current.cards.map((card) => card.workspace),
        all.map((item) => (item.id === tabId ? { ...item, workspaceId } : item)),
      );
    });
    void moveTab(tabId, workspaceId).then((saved) => {
      if (!saved) void refresh();
    });
  };

  const bindDrop = (target: string) => ({
    onDragOver: (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setDropTarget(target);
    },
    onDrop: onDrop(target),
  });

  const openTab = (tab: TabRef) => (event: MouseEvent) => {
    event.stopPropagation();
    if (afterDragClick(event)) return;
    openTabUrl(tab.url);
  };

  const toggleCard = (workspaceId: string) => (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest(".ws-name, .app-icon")) return;
    if (afterDragClick(event)) return;
    setExpandedId((current) => (current === workspaceId ? null : workspaceId));
  };

  const commitRename = async (workspace: Workspace, next: string) => {
    const name = next.trim().toLowerCase();
    if (name.length < 1 || name.length > 80 || name === workspace.name) return;
    setDirectory((current) => ({
      ...current,
      cards: current.cards.map((card) =>
        card.workspace.id === workspace.id
          ? { ...card, workspace: { ...card.workspace, name } }
          : card,
      ),
    }));
    const saved = await renameWorkspace(workspace.id, name);
    if (!saved) void refresh();
  };

  return (
    <div id="app" className="app view-enter" data-view="home">
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
              <Mark url={tab.url} title={tab.title} size={28} />
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
                <Mark key={tab.id} url={tab.url} title={tab.title} size={16} />
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
      className={`card${expanded ? " is-open" : " is-rising"}${dropTarget === card.workspace.id ? " is-drop" : ""}`}
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
              <Mark url={tab.url} title={tab.title} size={22} />
            </span>
          ))}
        </div>
      </div>
      {expanded ? (
        <div className="card-thirds">
          <div className="band">
            {card.tabs.map((tab) => (
              <button
                key={tab.id}
                className={`tab-row is-entering${draggingId === tab.id ? " is-dragging" : ""}`}
                type="button"
                draggable
                onDragStart={onDragStart(tab.id)}
                onDragEnd={onDragEnd}
                onClick={onOpenTab(tab)}
              >
                <Mark url={tab.url} title={tab.title} size={16} />
                <span className="tab-title">{tab.title.toLowerCase()}</span>
              </button>
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
            <div className="chat">
              <div className="chat-log">
                <div className="chat-empty">nothing asked yet</div>
              </div>
              <input
                className="ask"
                type="text"
                placeholder="ask the workspace anything"
                spellCheck={false}
                autoComplete="off"
                onClick={(event) => event.stopPropagation()}
              />
            </div>
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
