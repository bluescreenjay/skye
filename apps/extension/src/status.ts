// The only user-visible surface: a badge on the toolbar icon. It appears only
// when something needs attention (spec FR-011, FR-016); there is no popup.
import type { SyncStatus } from "./store";

const BADGE_RED = "#d93025";

/** What the badge says for each sync status. `null` means clear it. */
export function badgeFor(status: SyncStatus): { text: string; color?: string } {
  switch (status) {
    case "retrying":
      return { text: "…" };
    case "auth_failed":
    case "misconfigured":
      return { text: "!", color: BADGE_RED };
    default:
      return { text: "" };
  }
}

/** Shows the badge for a status. Never throws: a badge problem must not stop syncing. */
export async function applyStatus(status: SyncStatus): Promise<void> {
  try {
    const badge = badgeFor(status);
    await chrome.action.setBadgeText({ text: badge.text });
    if (badge.color) await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  } catch {
    // ignore
  }
}
