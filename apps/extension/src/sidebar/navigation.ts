/** Focus an existing Home tab or open one, then close this Side Panel instance. */
export async function openHomeAndClosePanel(): Promise<void> {
  const url = chrome.runtime.getURL("home.html");
  try {
    const existing = await chrome.tabs.query({ url });
    const tab = existing.find((item) => typeof item.id === "number");
    if (tab?.id != null) {
      if (typeof tab.windowId === "number") {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      await chrome.tabs.update(tab.id, { active: true });
    } else {
      await chrome.tabs.create({ url });
    }
  } catch {
    try {
      await chrome.tabs.create({ url });
    } catch {
      // Panel may still close below.
    }
  }
  window.close();
}
