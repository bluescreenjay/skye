import type { TabRef } from "@ai-browser/shared";
import type { DragEventHandler, MouseEventHandler } from "react";
import { TabMark } from "./TabMark";

export function TabRow({
  tab,
  className = "",
  draggable = false,
  onClick,
  onDragStart,
  onDragEnd,
}: {
  tab: TabRef;
  className?: string;
  draggable?: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
  onDragStart?: DragEventHandler<HTMLButtonElement>;
  onDragEnd?: DragEventHandler<HTMLButtonElement>;
}) {
  return (
    <button
      className={`tab-row${className ? ` ${className}` : ""}`}
      type="button"
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
    >
      <TabMark url={tab.url} title={tab.title} size={16} />
      <span className="tab-title">{tab.title.toLowerCase()}</span>
    </button>
  );
}
