# Feature Specification: Home — all workspaces

**Feature Branch**: `005-home-all-workspaces`

**Created**: 2026-09-19

**Status**: Draft

**Input**: User description: "Build the AI Browser Home view: the directory of all workspaces plus an Other bucket. Home is the landing page (Chrome new-tab / extension home), not a page you only reach after opening an article. Users should see every workspace at a glance, open a workspace to see its tabs, and understand the layout of their work. This is the forest view. Do not build the Chrome sidebar here—that is the in-tab workspace. Chat, live plans, and real actions can be stubbed. Layout must match the Home view in the provided HTML mock (home-design-prototype) exactly."

## Visual source of truth

Home’s layout, density, type, color, and interaction chrome MUST match the **Home view** of the checked-in mock:

`specs/005-home-all-workspaces/mocks/home-design-prototype/`

Open `index.html` in a browser (Home is the default view). Implement against that screen, not against a generic dashboard. The mock’s second view (icon rail + thick workspace panel + page frame) is the in-tab workspace and is **out of scope** for this feature.

Do not “improve” the Home layout into a marketing bento, a bookmark manager, or a generic AI console. If product copy and the mock disagree on Home structure, **the running mock wins**.

## Clarifications

### Session 2026-09-19

- Q: When someone clicks a tab icon or tab row on Home, and the in-tab sidebar is not built yet, what should happen? → A: Open the real page in a browser tab; Home stays open in its own tab.
- Q: Should the Home greeting ask for location so it can show local weather, like the mock? → A: Yes — use current location and local weather, with a quiet fallback if that fails.
- Q: Can someone create a new empty workspace from Home in this feature, or only see workspaces that already exist? → A: List and rename existing workspaces only; no create control on Home (create comes later).
- Q: If pairing or the server is missing, should Home show the mock’s dummy workspaces (furniture, type samples, and so on) or an empty real directory? → A: Real data only; empty Home chrome if unpaired, misconfigured, or the server is down. Never seed the mock’s dummy projects as the user’s work.
- Q: How should someone open Home in the browser? → A: New tab stays the browser default; Home opens only from the extension toolbar.

### Session 2026-09-19 (live Home tabs + close)

- Q: Should Home show saved TabRefs whose browser tabs are closed? → A: No — Home lists only live-bound tabs (`chromeTabId != null`). Backend rows stay; see [clarifications/live-home-tabs.md](clarifications/live-home-tabs.md).
- Q: Can the person close a Chrome tab from an expanded Home tab row? → A: Yes — right-side close control; durable TabRef is kept.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Land on a map of my work (Priority: P1)

A person opens Home from the extension toolbar (not by creating a new tab). They see a photo-backed Home: a skinny left icon rail, a large wordmark, a url field, a short greeting, and a vertical stack of workspace cards. Ungrouped pages (Other) live as icons on the rail. Named workspaces appear as cards and as compact stacked-icon tiles under a divider on the rail.

**Why this priority**: Constitution Two Surfaces: Home is the forest. If the only way to see work is to open a web page and use a sidebar, there is no directory.

**Independent Test**: Open Home from the toolbar with at least two named workspaces and a few ungrouped tabs. The person can name those workspaces, see Other on the rail, and recognize the same layout as the mock’s Home view. A separate new tab is still the browser’s default page, not Home.

**Acceptance Scenarios**:

1. **Given** the extension is installed, **When** the person opens Home from the toolbar, **Then** they see the Home layout from the mock: rail + main, not a blank page and not the workspace/page view.
2. **Given** the extension is installed, **When** they open a new tab the usual way, **Then** they get the browser’s default new tab, not Home.
3. **Given** named workspaces exist for this person, **When** Home loads, **Then** each workspace appears as a card in the main column and as a compact four-icon stack on the rail below the divider.
4. **Given** pages that belong to Other (no workspace), **When** Home loads, **Then** those pages appear as individual icons at the top of the rail, above the divider.
5. **Given** more workspace cards than fit on screen, **When** the person scrolls the main column, **Then** the rail stays put and the cards scroll.

---

### User Story 2 - Peek inside a workspace without leaving Home (Priority: P1)

The person expands one workspace card to see its tabs, stub action controls, a place to ask the workspace, and any created artifacts. Collapsed cards stay short: name plus as many tab icons as fit. Only one card is expanded at a time.

**Why this priority**: FEATURES.md “open a workspace overview from Home.” The mock’s expanded card *is* that overview. Live chat, plans, and real actions can be empty or dummy.

**Independent Test**: Collapse and expand cards until they match the mock: short bar vs tall three-column interior. Expanding a second card collapses the first.

**Acceptance Scenarios**:

1. **Given** a collapsed card, **When** the person clicks the card body (not the name, not a tab icon), **Then** it expands into three columns: tabs | actions + ask | artifacts, with the name and icon row remaining as a header.
2. **Given** one card is expanded, **When** the person expands another, **Then** the previous card returns to the collapsed height.
3. **Given** an expanded card, **When** they click the card header area again (not name/icons), **Then** it collapses.
4. **Given** a workspace with no artifacts, **When** the artifacts column is shown, **Then** it shows a quiet empty line such as “no artifacts yet,” not a decorative dropzone.
5. **Given** action buttons and the ask field, **When** the person uses them, **Then** they may no-op or show dummy feedback; they MUST NOT be required to call a live assistant for Home to ship.

---

### User Story 3 - Recognize Other vs named work (Priority: P1)

Other is a first-class bucket on Home, shown as ungrouped icons on the rail—not a fake workspace card with a generated name. Named work stays on cards.

**Why this priority**: Constitution: an Other bucket must exist. Forcing every tab into a named workspace breaks the product.

**Independent Test**: With mixed membership, rail-top icons are Other; cards are named workspaces only.

**Acceptance Scenarios**:

1. **Given** tabs in Other and tabs in workspaces, **When** Home is shown, **Then** Other tabs are not listed as a named workspace card titled “other” unless the mock itself does that (it does not; Other is the ungrouped rail).
2. **Given** a workspace with zero tabs, **When** Home lists workspaces, **Then** the workspace still appears (empty icon row / empty tab column).
3. **Given** Home, **When** the person looks for a way to add a new workspace, **Then** there is none in this feature; they only see workspaces that already exist.

---

### User Story 4 - Rename and rearrange on Home (Priority: P2)

The person can rename a workspace inline on the card. They cannot create a new workspace from Home in this feature. They can drag tab icons between cards, onto rail workspace tiles, and into the ungrouped rail. A drag does not count as a click.

**Why this priority**: The mock includes this; it makes Home feel like a work map. Syncing Chrome’s own tab groups is feature 007 and is not required here.

**Independent Test**: Rename persists after reload. Drag a tab from a card to the ungrouped rail and back; membership follows. Clicking still expands/selects; a completed drag does not also fire the click action.

**Acceptance Scenarios**:

1. **Given** a workspace card, **When** the person clicks the name and edits it, **Then** the new name shows on that card after they finish editing (Enter or blur), all lowercase.
2. **Given** a tab icon on Home, **When** they drag it onto another workspace card or rail tile, **Then** it belongs to that workspace on the next render.
3. **Given** a tab in a workspace, **When** they drop it on the ungrouped rail, **Then** it is Other.
4. **Given** a drag just finished, **When** the pointer is released, **Then** Home does not also treat that as “open this page in a browser tab” or “expand this card.”
5. **Given** a tab icon or tab row on Home, **When** the person clicks it (not a drag), **Then** that page opens in a normal browser tab and Home remains open in its existing tab. Home MUST NOT switch to the mock’s workspace/page layout.

---

### Edge Cases

- No workspaces and no Other tabs: Home still shows rail + wordmark + url field + greeting; main may have no cards. No “welcome to your AI workspace” hero. No create-workspace control.
- Unpaired, misconfigured, or directory unreachable: same Home chrome; empty rail and no workspace cards. Do not fall back to the HTML mock’s dummy workspace list.
- Loading or missing work data: keep the same layout; do not swap in a different template.
- Greeting weather: Home MAY request the person’s current location to fill local weather (same idea as the mock). If they decline, location is unavailable, or the forecast fails, keep the greeting layout and substitute a short fallback phrase (for example “hard to tell”) instead of hiding Home or showing an error screen.
- Long workspace names and many tabs: collapsed cards clip extra icons (no “+12 more” pill); expanded tab lists scroll inside the first column only.
- Archived workspaces: omit from the default Home list (same rule as the persistence directory: archived is hidden unless a later feature adds a way to show them).
- Url field: visual only for this feature (placeholder “url bar”); it MUST NOT be required to navigate the web for Home to succeed.
- Clicking a tab icon or tab row opens that page in a separate browser tab. Home stays on the Home layout in its own tab (it MUST NOT become the mock’s workspace/page view). The in-tab sidebar still does not exist in this feature.
- Opening a new tab the usual way shows the browser default, not Home. Home is only from the toolbar.
- Closing the browser and opening Home again from the toolbar still shows the same workspaces and Other for this person.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Home MUST be the directory of all of this person’s non-archived workspaces plus Other. It MUST open from the extension toolbar. It MUST NOT replace the browser’s default new-tab page in this feature.
- **FR-002**: Home MUST reproduce the mock Home layout: full-bleed photographic background; flush-left square icon rail (~icon-sidebar width); main column with large white wordmark “skye,” url field (placeholder “url bar”), greeting line, then a vertical stack of light rounded workspace cards with leftover photo visible around the ui.
- **FR-003**: The icon rail MUST show ungrouped (Other) tab icons on top, a hairline divider, then compact stacked-icon tiles for saved/named workspaces (up to four tiny icons per tile, iOS-style group). Icons only; no labels on the rail. Overflow scrolls inside the rail section, not the whole Home page.
- **FR-004**: Collapsed cards MUST be short: editable name on the left, then as many tab icons as fit on that row. Expanded cards MUST keep that header and add three equal columns (tabs | accent actions + ask field | artifacts) with hairline dividers. Only one card expanded at a time.
- **FR-005**: Copy on Home MUST be lowercase. Titles and names use the bold cut of one geometric sans; body and placeholders use a thinner cut of the same family. Text on the photo is white; names, titles, and action labels on light surfaces use the mock’s coral accent; secondary text on light surfaces uses the mock’s slate.
- **FR-006**: Action buttons, the ask field (placeholder “ask the workspace anything”), and artifacts MAY be stubs. They MUST occupy the mock’s regions so later chat/plan/actions can fill them without a layout rewrite.
- **FR-007**: Home MUST NOT implement the Chrome Side Panel, the mock’s workspace panel, or the large page frame. Those are the in-tab surface.
- **FR-008**: Home MUST NOT invent a second workspace identity. It displays the same workspaces and Other membership the persistence layer already stores for the paired person.
- **FR-009**: Home MUST show loading and empty states without changing information architecture (no alternate marketing layout). Cards and rail MUST reflect this person’s stored workspaces and Other only. Home MUST NOT populate the mock’s dummy projects (for example “refs — furniture”) as if they belonged to the person. If pairing is missing, the extension is misconfigured, or the directory cannot be loaded, keep the same Home chrome with an empty rail and no cards (a quiet status is allowed).
- **FR-010**: Inline rename of a workspace name on a card MUST persist for that person. Home MUST NOT provide a control to create a new workspace; creation is a later feature.
- **FR-011**: Dragging a tab between a workspace and Other on Home MUST persist membership. Applying the same grouping as native browser tab groups is out of scope.
- **FR-012**: This feature MUST NOT add clustering, command-bar execution, live browsing of the url field, settings/onboarding screens, or a create-workspace control.
- **FR-013**: Clicking a tab icon or tab row on Home MUST open that page’s address in a normal browser tab. Home MUST remain open on the Home layout. This MUST NOT replace Home with the mock’s workspace panel and page frame.
- **FR-014**: The greeting MUST include local time, weather for the person’s current location, and a short hint of current work, in the mock’s lowercase tone. Location is requested only for this greeting. If permission is denied or weather cannot be loaded, the greeting MUST still render with a quiet fallback; Home MUST NOT block on weather.

### Key Entities

- **Home**: The directory surface (forest). One per person, not per tab.
- **Workspace card**: A named durable workspace as a collapsible rectangle on Home.
- **Other / ungrouped**: Pages with no workspace; shown as rail icons, not as a named card.
- **Rail tile**: Compact visual of a workspace (stack of a few tab marks).
- **Artifact (stub)**: A created object on a workspace (note/board/file). Display only; creation may be dummy.
- **Greeting**: A short status line under the url field: local time, weather from the person’s current location, and a hint of current work. If location or weather is unavailable, the same line stays with a quiet fallback phrase.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A person who has used the HTML mock can open product Home and, within 10 seconds, confirm it is the same Home (rail, wordmark, url field, greeting, card stack)—not a different information architecture.
- **SC-002**: With at least two named workspaces and at least one Other tab, 100% of those items are visible after opening Home from the toolbar (cards and/or rail).
- **SC-003**: Expanding a workspace shows its member tabs in the first column in one interaction; collapsing returns to the short card. A second expand leaves only one card open.
- **SC-004**: After reload, renamed workspaces and dragged Other/workspace membership still match what the person last saw (for that paired identity).
- **SC-005**: Side-by-side with the mock, Home does not introduce glassmorphism, sparkle empty states, centered hero marketing copy, or a three-column marketing bento in place of the card stack.
- **SC-006**: This feature ships with no Side Panel chrome; success is “the directory exists and looks like the mock,” not “the in-tab workspace exists.”
- **SC-007**: Clicking a listed page on Home opens that address in a separate browser tab while Home remains visible as the directory (not converted into the in-tab workspace layout).
- **SC-008**: When location is allowed, the greeting names plausible local weather (not a blank line) within a few seconds; when it is not, Home still loads fully with a short fallback in that same greeting slot.
- **SC-009**: With no pairing, no server, or zero stored workspaces, Home still matches the mock’s chrome and does not show the prototype’s dummy named workspaces as live data.
- **SC-010**: After install, a normal new tab is still the browser default; Home appears when opened from the toolbar.

## Assumptions

- Persistence (workspaces, Other, pairing) already exists. Home is a client of that directory, including manual assignment if clustering is not done yet. The mock’s dummy dataset is visual reference only, not seed data.
- Home is opened from the extension toolbar in this feature. It does not take over the browser new-tab page (a later feature may). The directory still exists as its own surface, not only as a sidebar.
- The mock’s workspace/page view will be specified later as the Chrome sidebar feature. Clicking a tab on Home opens the real page in another browser tab; Home itself stays the directory.
- Product wordmark in the mock is “skye”; keep it. This feature does not rename the repo.
- Url field and ask field are visual/stub. Global command bar and live chat are later features.
- Drag-and-drop on Home updates stored membership only; it does not have to regroup native browser tabs (007).
- Creating a workspace from Home is deferred (correction / later feature). 005 only lists and renames what already exists.
- `main_background_old.jpg` is not part of the source of truth (removed as unused bulk). The mock uses `main_background.jpg`.
- Greeting weather uses the person’s current location (as in the mock). A public forecast is fine. Declining location or a failed forecast must not block Home.
