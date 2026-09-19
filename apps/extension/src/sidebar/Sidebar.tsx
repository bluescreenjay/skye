import { useEffect, useState } from "react";
import { loadConfig } from "../config";
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
          // Home / chrome:// / other non-pages: dismiss the panel itself.
          if (next.kind === "ineligible") {
            window.close();
            return;
          }
          setView(next);
        },
      );
    })().catch(() => {
      if (active) setView({ kind: "unavailable", message: "workspace unavailable" });
    });
    return () => {
      active = false;
      stop?.();
    };
  }, []);

  const title = workspaceTitle(view);
  const status = statusCopy(view);
  const tabs = view.kind === "named" || view.kind === "other" ? view.tabs : [];
  const activeTabId = view.kind === "named" || view.kind === "other" ? view.page.tabId : null;
  const url = activeUrl(view);

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
