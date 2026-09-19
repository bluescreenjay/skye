import type { TabRef } from "@ai-browser/shared";
import type { DragEventHandler, MouseEventHandler } from "react";
import { TabMark } from "./TabMark";

export function TabRow({
  tab,
  className = "",
  draggable = false,
  onClick,
  onClose,
  onDragStart,
  onDragEnd,
}: {
  tab: TabRef;
  className?: string;
  draggable?: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
  onClose?: MouseEventHandler<HTMLButtonElement>;
  onDragStart?: DragEventHandler<HTMLButtonElement>;
  onDragEnd?: DragEventHandler<HTMLButtonElement>;
}) {
  return (
    <div className={`tab-row${className ? ` ${className}` : ""}`}>
      <button
        className="tab-row-open"
        type="button"
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onClick}
      >
        <TabMark url={tab.url} title={tab.title} size={16} />
        <span className="tab-title">{tab.title.toLowerCase()}</span>
      </button>
      {onClose ? (
        <button
          className="tab-close"
          type="button"
          aria-label="close tab"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onClose(event);
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
