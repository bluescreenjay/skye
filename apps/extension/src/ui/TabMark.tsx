import { useEffect, useState } from "react";
import { markFromTab } from "../home/icons";

export function TabMark({ url, title, size }: { url: string; title: string; size: 16 | 22 | 28 }) {
  const { letter, hue } = markFromTab(url, title);
  const [showFavicon, setShowFavicon] = useState(() => /^https?:\/\//i.test(url));

  useEffect(() => {
    setShowFavicon(/^https?:\/\//i.test(url));
  }, [url]);

  if (showFavicon) {
    const faviconUrl = new URL(chrome.runtime.getURL("/_favicon/"));
    faviconUrl.searchParams.set("pageUrl", url);
    // Ask Chrome for a little more source resolution, then let CSS size it
    // down for the compact rail/card treatments.
    faviconUrl.searchParams.set("size", String(Math.max(size, 32)));
    return (
      <img
        className={`mark mark-favicon sz-${size}`}
        src={faviconUrl.toString()}
        alt=""
        aria-hidden
        onError={() => setShowFavicon(false)}
      />
    );
  }

  return (
    <span className={`mark mark-letter sz-${size} mark-h${hue}`} aria-hidden>
      {letter}
    </span>
  );
}
