import { markFromTab } from "../home/icons";

export function TabMark({ url, title, size }: { url: string; title: string; size: 16 | 22 | 28 }) {
  const { letter, hue } = markFromTab(url, title);
  return (
    <span className={`mark mark-letter sz-${size} mark-h${hue}`} aria-hidden>
      {letter}
    </span>
  );
}
