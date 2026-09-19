import { useEffect, useState } from "react";
import type { Workspace } from "@ai-browser/shared";
import { loadConfig } from "../config";
import {
  ignoreSuggestion,
  listPendingSuggestions,
  listWorkspaces,
  moveTab,
  putTabMembership,
} from "./corrections-api";
import { focusOrOpenSavedTab } from "../home/navigation";
import { TabRow } from "../ui/TabRow";
import { ToolPlaceholders } from "./ToolPlaceholders";
import { fetchPanelView } from "./api";
import { createSidebarContext, getPanelWindowId } from "./context";
import { openHomeAndClosePanel } from "./navigation";
import type { PanelView } from "./state";

const initialView: PanelView = { kind: "loading" };

function HomeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M1.5 5.2 6 1.75 10.5 5.2V10.25H7.4V7.15H4.6V10.25H1.5V5.2Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function workspaceTitle(view: PanelView): string {
  if (view.kind === "named") {
    return `${view.workspace.emoji ?? ""} ${view.workspace.name}`.trim().toLowerCase();
  }
  if (view.kind === "other") return "other";
  if (view.kind === "loading") return "workspace";
  return "workspace";
}

function statusCopy(view: PanelView): string | null {
  if (view.kind === "loading") return "loading workspace…";
  if (view.kind === "unavailable") return view.message;
  return null;
}

function activeUrl(view: PanelView): string {
  if (view.kind === "named" || view.kind === "other") return view.page.url;
  return "";
}

export function Sidebar() {
  const [view, setView] = useState<PanelView>(initialView);
  const [destinations, setDestinations] = useState<Workspace[]>([]);
  const [moveNote, setMoveNote] = useState("");
  const [moving, setMoving] = useState(false);
  const [suggestionId, setSuggestionId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    void (async () => {
      const windowId = await getPanelWindowId();
      if (!active) return;
      if (windowId === null) {
        setView({ kind: "unavailable", message: "open a normal browser window" });
        return;
      }
      const config = loadConfig(import.meta.env);
      if (!config.ok) {
        setView({ kind: "unavailable", message: "pairing needed" });
        return;
      }
      stop = createSidebarContext(
        windowId,
        (page, signal) => fetchPanelView(page, config.config, signal),
        (next) => {
          if (!active) return;
          if (next.kind === "ineligible") {
            window.close();
            return;
          }
          setView(next);
          setMoveNote("");
        },
      );
    })().catch(() => {
      if (active) setView({ kind: "unavailable", message: "workspace unavailable" });
    });
    return () => {
      active = false;
      stop?.();
    };
  }, [reloadKey]);

  useEffect(() => {
    void listWorkspaces().then((result) => {
      if (result.ok) setDestinations(result.value.filter((item) => item.status !== "archived"));
    });
  }, [view.kind === "named" || view.kind === "other" ? view.page.tabId : null]);

  useEffect(() => {
    if (view.kind !== "named" && view.kind !== "other") {
      setSuggestionId(null);
      return;
    }
    const tabRefId = view.tabRef?.id;
    if (!tabRefId) {
      setSuggestionId(null);
      return;
    }
    void listPendingSuggestions().then((result) => {
      if (!result.ok) {
        setSuggestionId(null);
        return;
      }
      const match = result.value.find((item) => item.tabRefIds.includes(tabRefId));
      setSuggestionId(match?.id ?? null);
    });
  }, [view]);

  const title = workspaceTitle(view);
  const status = statusCopy(view);
  const tabs = view.kind === "named" || view.kind === "other" ? view.tabs : [];
  const activeTabId = view.kind === "named" || view.kind === "other" ? view.page.tabId : null;
  const url = activeUrl(view);
  const currentWorkspaceId =
    view.kind === "named" ? view.workspace.id : view.kind === "other" ? null : undefined;

  const assignActive = (workspaceId: string | null) => {
    if (view.kind !== "named" && view.kind !== "other") return;
    if (currentWorkspaceId === workspaceId || moving) return;
    setMoving(true);
    setMoveNote("");
    const page = view.page;
    const existing = view.tabRef;
    void (async () => {
      try {
        const result = existing
          ? await moveTab(existing.id, workspaceId)
          : await putTabMembership(page.url, "", page.tabId, workspaceId);
        if (!result.ok) {
          setMoveNote("could not move this tab");
          return;
        }
        setReloadKey((value) => value + 1);
      } finally {
        setMoving(false);
      }
    })();
  };

  const onDismissSuggestion = () => {
    if (!suggestionId || moving) return;
    setMoving(true);
    void ignoreSuggestion(suggestionId).then((result) => {
      setMoving(false);
      if (!result.ok) {
        setMoveNote("could not dismiss that suggestion");
        return;
      }
      setSuggestionId(null);
    });
  };

  return (
    <aside className="panel" aria-label="workspace">
      <div className="panel-head">
        <button
          className="home-btn"
          type="button"
          onClick={() => {
            void openHomeAndClosePanel();
          }}
        >
          <HomeIcon />
          home
        </button>
        <p className="wordmark wordmark-panel">skye</p>
      </div>

      <h1 className="panel-workspace">{title}</h1>
      {status ? (
        <p className="panel-status" role="status">
          {status}
        </p>
      ) : null}
      {moveNote ? (
        <p className="panel-status" role="status">
          {moveNote}
        </p>
      ) : null}

      <input
        className="panel-url"
        type="text"
        readOnly
        value={url}
        placeholder="page address"
        aria-label="active page address"
        spellCheck={false}
        autoComplete="off"
      />

      {view.kind === "named" || view.kind === "other" ? (
        <section className="panel-move" aria-label="move this page">
          <label className="panel-move-label" htmlFor="panel-move-select">
            move this page
          </label>
          <select
            id="panel-move-select"
            className="panel-move-select"
            disabled={moving}
            value={currentWorkspaceId ?? "other"}
            onChange={(event) => {
              const next = event.target.value;
              assignActive(next === "other" ? null : next);
            }}
          >
            <option value="other">other</option>
            {destinations.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name.toLowerCase()}
              </option>
            ))}
          </select>
          {suggestionId ? (
            <button
              type="button"
              className="panel-dismiss"
              disabled={moving}
              onClick={onDismissSuggestion}
            >
              dismiss suggestion
            </button>
          ) : null}
        </section>
      ) : null}

      {view.kind === "named" || view.kind === "other" ? (
        <section
          className="panel-tabs"
          aria-label={view.kind === "named" ? "workspace tabs" : "other tabs"}
        >
          {tabs.length === 0 ? <p className="panel-empty">no saved tabs here yet</p> : null}
          {tabs.map((tab) => (
            <TabRow
              key={tab.id}
              tab={tab}
              className={tab.chromeTabId === activeTabId ? "is-active" : ""}
              onClick={() => {
                void focusOrOpenSavedTab(tab);
              }}
            />
          ))}
        </section>
      ) : (
        <section className="panel-tabs" aria-hidden />
      )}

      <ToolPlaceholders />
    </aside>
  );
}
