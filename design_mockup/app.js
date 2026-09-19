const greeting = {
  weather: "checking",
  started: false,
};

const ACTIONS = ["summarize", "collect refs", "new artifact"];

function formatTime() {
  return new Date()
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .toLowerCase();
}

function weatherPhrase(code, temp) {
  const rounded = Math.round(temp);
  if (code === 0) return `clear, ${rounded}°`;
  if (code <= 2) return `mostly clear, ${rounded}°`;
  if (code === 3) return `overcast, ${rounded}°`;
  if (code <= 48) return `foggy, ${rounded}°`;
  if (code <= 57) return `drizzling, ${rounded}°`;
  if (code <= 67) return `rainy, ${rounded}°`;
  if (code <= 77) return `snowy, ${rounded}°`;
  if (code <= 82) return `showers, ${rounded}°`;
  if (code <= 99) return `stormy, ${rounded}°`;
  return `${rounded}°`;
}

function browsingTrends() {
  const names = workspaces.slice(0, 3).map((item) => item.name.replace(/\s+/g, " "));
  if (names.length === 0) return "quiet for now";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]}, and ${names[2]}`;
}

function greetingText() {
  return `hi. it's ${formatTime()} and the weather where you are is ${greeting.weather}. some trends in your browsing tabs are ${browsingTrends()}. what will you get done today?`;
}

function loadWeather() {
  if (greeting.started) return;
  greeting.started = true;
  const fetchWeather = (lat, lon) => {
    fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`
    )
      .then((response) => response.json())
      .then((data) => {
        const current = data.current;
        greeting.weather = weatherPhrase(current.weather_code, current.temperature_2m);
        if (state.view === "home") render();
      })
      .catch(() => {
        greeting.weather = "hard to tell";
        if (state.view === "home") render();
      });
  };
  if (!navigator.geolocation) {
    fetchWeather(40.71, -74.01);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => fetchWeather(position.coords.latitude, position.coords.longitude),
    () => fetchWeather(40.71, -74.01),
    { timeout: 4000 }
  );
}

const ungroupedTabs = [
  tab("u1", "figma community", "figma"),
  tab("u2", "read.cv / studios", "linkedin"),
  tab("u3", "material studies", "pinterest"),
  tab("u4", "local — 3000", "vscode"),
];

const workspaces = [
  {
    id: "w1",
    name: "refs — furniture",
    open: true,
    tabs: [
      tab("w1t1", "cassina — 699 superleggera", "safari"),
      tab("w1t2", "vitra — eames walnut", "chrome"),
      tab("w1t3", "dezeen / collectible seating", "google"),
      tab("w1t4", "moma collection — stools", "instagram"),
      tab("w1t5", "are.na / wood joints", "pinterest"),
      tab("w1t6", "usm haller configurations", "shopify"),
      tab("w1t7", "hay — soft edge", "youtube"),
      tab("w1t8", "carlhansen — wishbone", "wikipedia"),
    ],
    artifacts: [
      artifact(
        "note",
        "material list",
        "walnut, powder-coated steel, vegetable-tanned leather. keep the mix quiet — one warm wood, one cool metal."
      ),
      artifact(
        "board",
        "seating board",
        "superleggera, wishbone, and soft edge in one line. scale the walnut darker than the photos."
      ),
    ],
  },
  {
    id: "w2",
    name: "type samples",
    open: false,
    tabs: [
      tab("w2t1", "abc din pro specimen", "adobe"),
      tab("w2t2", "söhne schmal", "google-docs"),
      tab("w2t3", "lyon display", "framer"),
    ],
    artifacts: [],
  },
  {
    id: "w3",
    name: "client — atelier",
    open: true,
    tabs: [
      tab("w3t1", "atelier brief — v3", "notion"),
      tab("w3t2", "site map draft", "linear"),
      tab("w3t3", "references — store interiors", "pinterest"),
      tab("w3t4", "palette board", "adobe"),
      tab("w3t5", "type pairing notes", "google-docs"),
      tab("w3t6", "lookbook pdf", "dropbox"),
      tab("w3t7", "competitor — leclaireur", "safari"),
      tab("w3t8", "competitor — totême", "instagram"),
      tab("w3t9", "photography direction", "behance"),
      tab("w3t10", "homepage wire", "figma"),
      tab("w3t11", "product grid", "shopify"),
      tab("w3t12", "press sheet", "gmail"),
    ],
    artifacts: [
      artifact(
        "note",
        "atelier notes",
        "store as a quiet room. circulation along the left, product as objects not a grid. no chrome, no hard spots."
      ),
      artifact(
        "file",
        "grid system",
        "12 columns, 8px. cards sit on a 4-unit. type: söhne for ui, lyon for display."
      ),
      artifact(
        "board",
        "look 01",
        "cream wall, one coral object, slate floor. photography: noon, no flash, waist height."
      ),
    ],
  },
  {
    id: "w4",
    name: "reading",
    open: false,
    tabs: [
      tab("w4t1", "the fashion system", "wikipedia"),
      tab("w4t2", "objects of desire", "apple"),
      tab("w4t3", "on weaving", "youtube"),
      tab("w4t4", "ways of seeing", "reddit"),
      tab("w4t5", "in praise of shadows", "google-docs"),
    ],
    artifacts: [
      artifact(
        "note",
        "quote list",
        "the fashion system — clothing as writing. objects of desire — furniture as class. on weaving — structure before surface."
      ),
    ],
  },
  {
    id: "w5",
    name: "palettes",
    open: false,
    tabs: [
      tab("w5t1", "coral / cream / slate", "adobe"),
      tab("w5t2", "ink on uncoated", "google-drive"),
    ],
    artifacts: [],
  },
  {
    id: "w6",
    name: "site — milan",
    open: false,
    tabs: [
      tab("w6t1", "10 corso como", "instagram"),
      tab("w6t2", "fondazione prada", "safari"),
      tab("w6t3", "spazio maiocchi", "apple-maps"),
      tab("w6t4", "nonostante marras", "tumblr"),
      tab("w6t5", "garage italia", "youtube"),
      tab("w6t6", "osbyn notes", "notion"),
      tab("w6t7", "fuorisalone archive", "chrome"),
    ],
    artifacts: [
      artifact(
        "file",
        "vendor pdf",
        "milan millwork, lead 6 weeks. finishes: raw oak, smoked, blackened steel. no high gloss."
      ),
    ],
  },
];

const state = {
  view: "home",
  expandedId: "w3",
  selectedWorkspaceId: null,
  selectedTabId: null,
  risingId: null,
  expandingId: null,
  collapsingId: null,
  viewEnter: false,
  focusAsk: null,
};

function tab(id, title, icon) {
  return { id, title, icon };
}

function artifact(kind, title, body) {
  return { id: `${kind}-${title}`, kind, title, body };
}

const ungroupedThread = {
  id: "ungrouped",
  name: "ungrouped tabs",
  tabs: ungroupedTabs,
  messages: [],
  askDraft: "",
};

function threadFor(workspace) {
  if (!workspace.messages) workspace.messages = [];
  if (!workspace.openArtifactIds) workspace.openArtifactIds = [];
  if (workspace.askDraft == null) workspace.askDraft = "";
  return workspace;
}

function chatReply(workspace, question) {
  const names = (workspace.tabs || []).slice(0, 3).map((item) => item.title);
  if (/summari|collect|ref/i.test(question)) {
    return names.length
      ? `pulled from ${workspace.name}: ${names.join("; ")}.`
      : `nothing to pull from ${workspace.name} yet.`;
  }
  return names.length
    ? `in ${workspace.name}, i'd start with ${names[0]}.`
    : `nothing open in ${workspace.name} yet.`;
}

function sendAsk(workspace, text) {
  const thread = threadFor(workspace);
  const question = String(text || "").trim();
  if (!question) return;
  thread.messages.push({ role: "you", text: question });
  thread.messages.push({ role: "skye", text: chatReply(thread, question) });
  thread.askDraft = "";
  state.focusAsk = thread.id;
  render();
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.slice(0, 2) === "on" && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

const enteredIcons = new Set();

const drag = {
  tabId: null,
  fromClick: false,
};

function markNode(item, size) {
  return el("img", {
    class: `mark sz-${size}`,
    src: `icons/${item.icon}.png`,
    alt: "",
    draggable: "false",
  });
}

function highlightDrop(node) {
  document.querySelectorAll(".is-drop").forEach((item) => {
    if (item !== node) item.classList.remove("is-drop");
  });
  node.classList.add("is-drop");
}

function bindDrag(node, tabId) {
  node.setAttribute("draggable", "true");
  node.addEventListener("dragstart", (event) => {
    drag.tabId = tabId;
    drag.fromClick = true;
    event.dataTransfer.setData("text/plain", tabId);
    event.dataTransfer.effectAllowed = "move";
    const image = node.querySelector("img") || node;
    try {
      event.dataTransfer.setDragImage(
        image,
        (image.offsetWidth || 22) / 2,
        (image.offsetHeight || 22) / 2
      );
    } catch (_) {}
    node.classList.add("is-dragging");
    document.body.classList.add("dragging-apps");
  });
  node.addEventListener("dragend", () => {
    node.classList.remove("is-dragging");
    document.body.classList.remove("dragging-apps");
    document.querySelectorAll(".is-drop").forEach((item) => item.classList.remove("is-drop"));
    drag.tabId = null;
    setTimeout(() => {
      drag.fromClick = false;
    }, 60);
  });
  return node;
}

function bindDrop(node, dest, beforeId) {
  node.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    highlightDrop(node);
  });
  node.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const id = event.dataTransfer.getData("text/plain") || drag.tabId;
    moveTab(id, dest, beforeId);
  });
  return node;
}

function takeTab(id) {
  enteredIcons.delete(id);
  const loose = ungroupedTabs.findIndex((item) => item.id === id);
  if (loose !== -1) return ungroupedTabs.splice(loose, 1)[0];
  for (const workspace of workspaces) {
    const index = workspace.tabs.findIndex((item) => item.id === id);
    if (index !== -1) return workspace.tabs.splice(index, 1)[0];
  }
  return null;
}

function insertTab(item, dest, beforeId) {
  const list = dest === "ungrouped"
    ? ungroupedTabs
    : workspaces.find((workspace) => workspace.id === dest)?.tabs;
  if (!list) return;
  if (beforeId) {
    const index = list.findIndex((tabItem) => tabItem.id === beforeId);
    if (index !== -1) {
      list.splice(index, 0, item);
      return;
    }
  }
  list.push(item);
}

function moveTab(tabId, dest, beforeId) {
  if (!tabId || tabId === beforeId) return;
  const found = findTab(tabId);
  if (!found.tab) return;
  const sameList =
    (dest === "ungrouped" && !found.workspace) ||
    (found.workspace && found.workspace.id === dest);
  if (sameList && !beforeId) return;
  const item = takeTab(tabId);
  if (!item) return;
  insertTab(item, dest, beforeId);
  if (state.selectedTabId === tabId) {
    state.selectedWorkspaceId = dest === "ungrouped" ? null : dest;
  }
  render();
}

function afterDragClick(event) {
  if (!drag.fromClick) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function draggableIcon(item, size, dest, index) {
  const node = bindDrag(
    el("span", {
      class: "app-icon",
      dataset: { id: item.id },
      onclick: (event) => {
        event.stopPropagation();
        if (afterDragClick(event)) return;
        const found = findTab(item.id);
        if (found.workspace) openWorkspace(found.workspace.id, item.id);
        else openUngrouped(item.id);
      },
    }),
    item.id
  );
  if (dest) bindDrop(node, dest, item.id);
  if (!enteredIcons.has(item.id)) {
    node.classList.add("is-entering");
    node.style.setProperty("--i", String(index ?? 0));
    enteredIcons.add(item.id);
  }
  node.append(markNode(item, size));
  return node;
}

function findTab(id) {
  const loose = ungroupedTabs.find((item) => item.id === id);
  if (loose) return { tab: loose, workspace: null };
  for (const workspace of workspaces) {
    const found = workspace.tabs.find((item) => item.id === id);
    if (found) return { tab: found, workspace };
  }
  return { tab: null, workspace: null };
}

function selectedTabRecord() {
  if (!state.selectedTabId) return { tab: null, workspace: null };
  return findTab(state.selectedTabId);
}

function bumpWorkspace(id) {
  const index = workspaces.findIndex((item) => item.id === id);
  if (index < 0) return false;
  if (index === 0) return false;
  const [item] = workspaces.splice(index, 1);
  workspaces.unshift(item);
  return true;
}

function openUngrouped(tabId) {
  state.view = "workspace";
  state.selectedWorkspaceId = null;
  state.selectedTabId = tabId;
  render();
}

function openWorkspace(workspaceId, tabId) {
  const workspace = workspaces.find((item) => item.id === workspaceId);
  if (!workspace) return;
  workspace.open = true;
  if (bumpWorkspace(workspace.id)) state.risingId = workspace.id;
  state.expandedId = workspace.id;
  state.view = "workspace";
  state.selectedWorkspaceId = workspace.id;
  state.selectedTabId = tabId || workspace.tabs[0]?.id || null;
  render();
}

function goHome() {
  state.view = "home";
  render();
}

function currentTabs() {
  if (!state.selectedWorkspaceId) return ungroupedTabs;
  const workspace = workspaces.find((item) => item.id === state.selectedWorkspaceId);
  return workspace ? workspace.tabs : ungroupedTabs;
}

function makeName(workspace) {
  const node = el("span", { class: "ws-name", text: workspace.name });
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    node.contentEditable = "true";
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  node.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      node.blur();
    }
  });
  node.addEventListener("blur", () => {
    node.contentEditable = "false";
    const next = node.textContent.trim().toLowerCase();
    workspace.name = next || workspace.name;
    node.textContent = workspace.name;
  });
  return node;
}

function iconStack(tabs, size, dest) {
  return el(
    "div",
    { class: "card-icons" },
    tabs.map((item, index) => draggableIcon(item, size, dest, index))
  );
}

function tabRows(tabs, dest, onPick, animate) {
  return tabs.map((item, index) => {
    const row = el(
      "button",
      {
        class: `tab-row${
          state.view === "workspace" && item.id === state.selectedTabId
            ? " is-active"
            : ""
        }${animate ? " is-entering" : ""}`,
        type: "button",
        onclick: (event) => {
          event.stopPropagation();
          if (afterDragClick(event)) return;
          onPick(item.id);
        },
      },
      [markNode(item, 16), el("span", { class: "tab-title", text: item.title })]
    );
    row.style.setProperty("--i", String(index));
    bindDrag(row, item.id);
    bindDrop(row, dest, item.id);
    return row;
  });
}

function actionRow(workspace) {
  const thread = threadFor(workspace);
  return el(
    "div",
    { class: "actions" },
    ACTIONS.map((label) =>
      el("button", {
        class: "btn",
        type: "button",
        text: label,
        onclick: (event) => {
          event.stopPropagation();
          if (label === "new artifact") {
            if (!thread.artifacts) return;
            const n = thread.artifacts.filter((item) => item.kind === "note").length + 1;
            const item = artifact(
              "note",
              `note ${n}`,
              "a new note from this workspace."
            );
            thread.artifacts.push(item);
            if (!thread.openArtifactIds.includes(item.id)) {
              thread.openArtifactIds.push(item.id);
            }
            render();
            return;
          }
          sendAsk(thread, label);
        },
      })
    )
  );
}

function chatBox(workspace) {
  const thread = threadFor(workspace);
  const log = el(
    "div",
    { class: "chat-log" },
    thread.messages.length
      ? thread.messages.map((item) =>
          el("div", { class: `chat-msg is-${item.role}` }, [
            el("span", { class: "chat-who", text: item.role === "you" ? "you" : "skye" }),
            el("p", { class: "chat-text", text: item.text }),
          ])
        )
      : [el("div", { class: "chat-empty", text: "nothing asked yet" })]
  );
  requestAnimationFrame(() => {
    log.scrollTop = log.scrollHeight;
  });
  const input = el("input", {
    class: "ask",
    type: "text",
    placeholder: "ask the workspace anything",
    spellcheck: "false",
    autocomplete: "off",
    value: thread.askDraft,
    dataset: { ask: thread.id },
    oninput: (event) => {
      thread.askDraft = event.target.value;
    },
    onkeydown: (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      sendAsk(thread, event.target.value);
    },
    onclick: (event) => event.stopPropagation(),
  });
  return el("div", { class: "chat" }, [log, input]);
}

function artifactList(workspace) {
  const thread = threadFor(workspace);
  if (!thread.artifacts.length) {
    return [el("div", { class: "empty", text: "no artifacts yet" })];
  }
  return thread.artifacts.map((item) => {
    const open = thread.openArtifactIds.includes(item.id);
    return el("div", { class: `artifact${open ? " is-open" : ""}` }, [
      el(
        "button",
        {
          class: "artifact-head",
          type: "button",
          onclick: (event) => {
            event.stopPropagation();
            if (open) {
              thread.openArtifactIds = thread.openArtifactIds.filter(
                (id) => id !== item.id
              );
            } else {
              thread.openArtifactIds.push(item.id);
            }
            render();
          },
        },
        [
          el("span", { class: "artifact-kind", text: item.kind }),
          el("span", { class: "artifact-title", text: item.title }),
        ]
      ),
      open &&
        el("div", {
          class: "artifact-body",
          text: item.body || "empty for now.",
        }),
    ]);
  });
}

function groupTile(workspace, selected) {
  const marks = workspace.tabs.slice(0, 4).map((item) => markNode(item, 16));
  const tile = el(
    "button",
    {
      class: `group-tile${selected ? " is-selected" : ""}`,
      type: "button",
      title: workspace.name,
      onclick: (event) => {
        if (afterDragClick(event)) return;
        openWorkspace(workspace.id);
      },
    },
    marks
  );
  bindDrop(tile, workspace.id);
  return tile;
}

function renderRail() {
  const rail = document.getElementById("rail");
  rail.replaceChildren();

  const ungrouped = el("div", { class: "rail-section rail-ungrouped" });
  bindDrop(ungrouped, "ungrouped");
  ungroupedTabs.forEach((item) => {
    const button = el(
      "button",
      {
        class: `rail-icon${
          !state.selectedWorkspaceId && item.id === state.selectedTabId
            ? " is-selected"
            : ""
        }`,
        type: "button",
        title: item.title,
        onclick: (event) => {
          if (afterDragClick(event)) return;
          openUngrouped(item.id);
        },
      },
      [markNode(item, 28)]
    );
    bindDrag(button, item.id);
    bindDrop(button, "ungrouped", item.id);
    ungrouped.append(button);
  });

  rail.append(ungrouped, el("div", { class: "rail-divider" }));

  if (state.view === "workspace") {
    const open = workspaces.filter((item) => item.open);
    rail.append(
      el(
        "div",
        { class: "rail-section rail-open" },
        open.map((item) =>
          groupTile(item, state.selectedWorkspaceId === item.id)
        )
      ),
      el("div", { class: "rail-divider" })
    );
  }

  rail.append(
    el(
      "div",
      { class: "rail-section rail-saved" },
      workspaces.map((item) =>
        groupTile(
          item,
          state.view === "workspace" &&
            state.selectedWorkspaceId === item.id &&
            !item.open
        )
      )
    )
  );
}

function renderHome() {
  const home = document.getElementById("home");
  const scroll = home.scrollTop;
  const cards = workspaces.map((workspace, index) => {
    const collapsing = state.collapsingId === workspace.id;
    const open = state.expandedId === workspace.id || collapsing;
    const card = el("article", {
      class: `card${open ? " is-open" : ""}${
        state.risingId === workspace.id ? " is-rising" : ""
      }${state.expandingId === workspace.id ? " is-expanding" : ""}${
        collapsing ? " is-collapsing" : ""
      }`,
      dataset: { id: workspace.id },
    });
    card.style.setProperty("--c", String(index));

    const head = el("div", { class: "card-head" }, [
      makeName(workspace),
      iconStack(workspace.tabs, 22, workspace.id),
    ]);

    head.addEventListener("click", (event) => {
      if (event.target.closest(".ws-name, .app-icon")) return;
      if (afterDragClick(event)) return;
      if (state.collapsingId) return;
      event.stopPropagation();
      if (open && !collapsing) {
        state.collapsingId = workspace.id;
      } else if (!open) {
        if (state.expandedId && state.expandedId !== workspace.id) {
          state.collapsingId = state.expandedId;
        }
        bumpWorkspace(workspace.id);
        state.expandedId = workspace.id;
        state.expandingId = workspace.id;
        state.risingId = workspace.id;
      }
      render();
    });

    card.append(head);
    bindDrop(card, workspace.id);

    if (open) {
      card.append(
        el("div", { class: "card-thirds" }, [
          el("div", { class: "band" }, tabRows(workspace.tabs, workspace.id, (tabId) => openWorkspace(workspace.id, tabId), state.expandingId === workspace.id)),
          el("div", { class: "band band-actions" }, [actionRow(workspace), chatBox(workspace)]),
          el("div", { class: "band band-artifacts" }, artifactList(workspace)),
        ])
      );
    }

    if (collapsing) {
      const finish = () => {
        if (state.collapsingId !== workspace.id) return;
        if (state.expandedId === workspace.id) state.expandedId = null;
        state.collapsingId = null;
        render();
      };
      card.addEventListener("animationend", (event) => {
        if (event.target !== card || event.animationName !== "collapse-out") return;
        finish();
      });
      setTimeout(finish, 560);
    }

    return card;
  });

  home.replaceChildren(
    el("div", { class: "home-top" }, [
      el("p", { class: "wordmark", text: "skye" }),
      el("input", {
        class: "url-bar",
        type: "text",
        placeholder: "url bar",
        spellcheck: "false",
        autocomplete: "off",
      }),
      el("p", { class: "greeting", text: greetingText() }),
    ]),
    ...cards
  );
  if (state.risingId) home.scrollTop = 0;
  else home.scrollTop = scroll;
}

function homeIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("fill", "none");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M1.5 5.2 6 1.75 10.5 5.2V10.25H7.4V7.15H4.6V10.25H1.5V5.2Z");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.2");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

function renderWorkspace() {
  const panel = document.getElementById("panel");
  const page = document.getElementById("page");
  const tabs = currentTabs();
  const { tab: active } = selectedTabRecord();

  const dest = state.selectedWorkspaceId || "ungrouped";
  const workspace =
    workspaces.find((item) => item.id === state.selectedWorkspaceId) ||
    ungroupedThread;
  const panelTabs = bindDrop(
    el(
      "div",
      { class: "panel-tabs" },
      tabRows(tabs, dest, (tabId) => {
        state.selectedTabId = tabId;
        render();
      }, state.viewEnter)
    ),
    dest
  );
  panel.replaceChildren(
    el("div", { class: "panel-head" }, [
      el("button", { class: "home-btn", type: "button", onclick: goHome }, [
        homeIcon(),
        "home",
      ]),
      el("p", { class: "wordmark wordmark-panel", text: "skye" }),
    ]),
    el("input", {
      class: "panel-url",
      type: "text",
      placeholder: "url bar",
      spellcheck: "false",
      autocomplete: "off",
    }),
    panelTabs,
    el("div", { class: "panel-dock" }, [actionRow(workspace), chatBox(workspace)])
  );

  page.replaceChildren(
    el("div", { class: "page-frame" }, [
      el("h1", { class: "page-title", text: active ? active.title : "untitled" }),
    ])
  );
}

function render() {
  const app = document.getElementById("app");
  state.viewEnter = lastView !== null && lastView !== state.view;
  lastView = state.view;
  app.dataset.view = state.view;
  app.classList.toggle("view-enter", state.viewEnter);
  const nextHash = state.view === "workspace" ? "#workspace" : "#home";
  if (location.hash !== nextHash) {
    history.replaceState(null, "", nextHash);
  }
  renderRail();
  renderHome();
  if (state.view === "workspace") renderWorkspace();
  if (state.focusAsk) {
    const ask = document.querySelector(`[data-ask="${state.focusAsk}"]`);
    if (ask) ask.focus();
    state.focusAsk = null;
  }
  state.risingId = null;
  state.expandingId = null;
}

let lastView = null;

function applyHash() {
  if (location.hash === "#workspace") {
    state.view = "workspace";
    if (!state.selectedWorkspaceId && !state.selectedTabId) {
      const open = workspaces.find((item) => item.open) || workspaces[0];
      state.selectedWorkspaceId = open.id;
      state.selectedTabId = open.tabs[0].id;
    }
    return;
  }
  state.view = "home";
}

window.addEventListener("hashchange", () => {
  applyHash();
  render();
});

applyHash();
if (state.expandedId) bumpWorkspace(state.expandedId);
loadWeather();
render();
