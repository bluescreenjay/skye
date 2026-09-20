# Feature Specification: Mobile Companion

**Feature Branch**: `014-mobile-companion`

**Created**: 2026-09-19

**Status**: Draft

**Input**: User description: "Add a mobile companion as a separate mobile web app that is a remote interface to the same persistent workspaces—not a second browser and not a Side Panel clone. Pair the phone to the desktop person via a short-lived QR code or one-time code shown on desktop; redeeming it issues a durable per-device credential for the same person (not an ephemeral session-only login). Users can list workspaces (Home-like), ask questions, review plans and agent results, and trigger actions. Desktop Home, desktop sidebar, and mobile must share the same workspace state. Lightly include ElevenLabs voice on mobile (hear chat replies; optional speak-to-ask)—nice-to-have, must not block pairing or text chat."

## Clarifications

### Session 2026-09-19

- Q: For the first shippable slice of the mobile companion, what must work end-to-end? → A: Pair + directory + workspace chat (agents and voice later in this feature)
- Q: How long should a desktop pairing code or QR stay valid before it expires? → A: About 5 minutes (default; clarification ended early by request)
- Deferred (defaults for planning): pairing starts from desktop Home; at most a small number of mobile devices per person (practical default: up to 3); voice is tap-to-listen, not auto-play

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Pair phone to the same person (Priority: P1)

A person already using AI Browser on desktop wants their phone to see the same workspaces. On desktop they start pairing and see a short-lived code and/or scannable QR. On the mobile companion they enter the code or scan the QR. Pairing succeeds and the phone is linked as another device for that same person. After closing and reopening the mobile companion, they remain paired without repeating the ceremony.

**Why this priority**: Without a trusted link to the same person, mobile cannot show real workspaces and is useless as a companion.

**Independent Test**: From a paired desktop account, complete QR or code pairing on a fresh mobile companion session; confirm the phone sees that person’s workspaces and still does after a full reload of the mobile app.

**Acceptance Scenarios**:

1. **Given** a person paired on desktop, **When** they start pairing on desktop, **Then** they see a short-lived one-time code and a QR that encodes the same pairing offer.
2. **Given** a valid unused pairing offer, **When** the person completes it on the mobile companion, **Then** the phone is linked to that same person and can load their workspaces.
3. **Given** a successful pair, **When** the person closes and later reopens the mobile companion, **Then** they remain paired without entering a new code.
4. **Given** an expired or already-used pairing offer, **When** someone tries to redeem it, **Then** pairing fails with a clear message and no new device is linked.
5. **Given** a paired phone, **When** the person revokes that device from desktop (or equivalent), **Then** the mobile companion can no longer access their workspaces until they pair again.

---

### User Story 2 - Browse workspaces on the phone (Priority: P1)

After pairing, the person opens the mobile companion and sees a Home-like list of their named workspaces and Other-style unassigned context enough to pick what they are working on. Selecting a workspace shows its saved pages (titles/addresses) consistent with desktop. Changes made on desktop (organize, moves, renames) appear on the phone after refresh or a short wait.

**Why this priority**: Listing and opening workspace context is the core “remote interface” value; chat and actions build on it.

**Independent Test**: With at least two workspaces on desktop, pair the phone and confirm the same names and memberships appear; move a tab on desktop and confirm the phone reflects it after refresh.

**Acceptance Scenarios**:

1. **Given** a paired person with named workspaces on desktop, **When** they open the mobile companion, **Then** they see those workspaces (and Other as appropriate) without inventing separate mobile-only groups.
2. **Given** a workspace with saved pages, **When** the person opens it on mobile, **Then** they see the same pages that desktop shows for that workspace.
3. **Given** a membership or rename change on desktop, **When** the person refreshes or returns to the mobile list, **Then** the phone shows the updated state.
4. **Given** another person’s workspaces, **When** the paired person uses mobile, **Then** they never see that other person’s workspaces.

---

### User Story 3 - Ask on a workspace from mobile (Priority: P1)

From a selected workspace on the phone, the person can ask questions in that workspace’s conversation (same history visible on desktop for that workspace). Results stay attached to the workspace so desktop and phone both see them later. Running workspace agents/actions from mobile is part of this feature but ships after pair + directory + chat.

**Why this priority**: Chat makes the companion useful away from the desk; pair + browse alone is incomplete for a remote assistant. Agents and voice follow once chat works.

**Independent Test**: Send a workspace question from mobile and confirm the reply and history appear on desktop for that workspace.

**Acceptance Scenarios**:

1. **Given** a paired person on a workspace that already has chat on desktop, **When** they open chat on mobile, **Then** they see the same conversation history for that workspace.
2. **Given** a workspace on mobile, **When** the person sends a question, **Then** they get an answer grounded in that workspace’s context and the message is stored on the workspace.
3. **Given** the mobile companion is unpaired or revoked, **When** the person tries to chat, **Then** the request is refused and no workspace data is shown.

---

### User Story 3b - Run agents from mobile (Priority: P2)

Where the product already exposes workspace agents or actions for a workspace, the person can trigger them from mobile. Results persist on the workspace shared with desktop. This ships after the chat path in this feature.

**Why this priority**: Agents extend the companion but are not required for the first end-to-end slice.

**Independent Test**: Run one available agent/action from mobile and confirm the saved result is visible on both surfaces.

**Acceptance Scenarios**:

1. **Given** agents or actions available for that workspace on desktop, **When** the person runs one from mobile, **Then** the run completes and its result is visible later on desktop and mobile for that workspace.
2. **Given** the mobile companion is unpaired or revoked, **When** the person tries to run an agent, **Then** the request is refused.

---

### User Story 4 - Use the companion as a phone web app (Priority: P2)

The mobile companion is a separate mobile-oriented web experience (not the desktop Home layout forced small, and not a Chrome Side Panel clone). The person can add it to their home screen or bookmark it and use it in a normal phone browser. Layout and controls are usable with a thumb on a phone-sized screen.

**Why this priority**: Delivery as a mobile web app is the chosen product shape; without mobile-first presentation the companion fails day-to-day use.

**Independent Test**: Open the companion URL on a phone-sized viewport; complete pair → list → open workspace without horizontal overflow or desktop-only controls that block the flow.

**Acceptance Scenarios**:

1. **Given** a phone-sized screen, **When** the person uses pair, list, and workspace views, **Then** primary actions remain reachable without requiring a desktop layout.
2. **Given** the companion URL, **When** the person opens it in a normal mobile browser, **Then** they can complete pairing and browse workspaces without installing a native store app.
3. **Given** desktop Home and the Chrome Side Panel, **When** comparing to mobile, **Then** mobile does not claim to control Chrome tabs or replace the Side Panel; it is a remote workspace interface only.

---

### User Story 5 - Light voice on mobile (Priority: P3)

On a paired phone, in workspace chat, the person can optionally hear assistant replies spoken aloud (natural speech via the product’s voice capability) and, if available, speak a short question instead of typing. Text chat remains the source of truth; voice is another way in and out of the same conversation. If voice is unavailable, pairing and typed chat still work.

**Why this priority**: Voice makes the companion feel alive on a phone, but pairing and text are the product; voice should not gate the feature.

**Independent Test**: With voice configured, play a chat reply aloud on mobile and confirm the same reply remains in text history on desktop; turn voice off or unset credentials and confirm typed chat still works.

**Acceptance Scenarios**:

1. **Given** a workspace chat reply on mobile and voice available, **When** the person chooses to hear it, **Then** they hear spoken audio for that reply without creating a separate conversation.
2. **Given** voice input available, **When** the person speaks a short question into chat, **Then** it appears as a normal text user message in the same workspace history (desktop and mobile).
3. **Given** voice is missing or fails, **When** the person uses the companion, **Then** pair, list, and typed chat still succeed with a quiet indication that voice is unavailable.

### Edge Cases

- Pairing started on desktop but never finished: the offer expires and desktop can start a new one; old codes stop working.
- Phone already paired to person A tries to redeem a code for person B: refuse until the existing device is revoked (default).
- Offline or unreachable server during pairing or browse: clear failure; no fabricated workspaces.
- Empty directory (no workspaces yet): mobile shows an honest empty state, not sample data.
- Voice credentials missing, mic permission denied, or playback blocked: degrade to text only; never block pair/list/chat.
- Spoken input that cannot be understood: keep the person in chat with a clear retry; do not invent a message.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Desktop MUST let a paired person start a short-lived, single-use pairing offer shown as a human-enterable code and as a scannable QR encoding that same offer.
- **FR-002**: The mobile companion MUST redeem a valid pairing offer and become a distinct device linked to the same person as the desktop session that created the offer.
- **FR-003**: After a successful pair, the mobile companion MUST keep a durable per-device credential so the person stays paired across app restarts until they revoke or re-pair.
- **FR-004**: Pairing offers MUST expire after about 5 minutes and MUST NOT be reusable after a successful redemption.
- **FR-005**: The person MUST be able to revoke a mobile device from desktop so that device loses access immediately.
- **FR-006**: The mobile companion MUST present a Home-like directory of that person’s workspaces (and Other as the product already defines) from the same durable workspace state as desktop—not a separate mobile-only catalog.
- **FR-007**: Opening a workspace on mobile MUST show that workspace’s saved pages consistent with desktop for the same person.
- **FR-008**: The mobile companion MUST support workspace chat against the same per-workspace conversation the desktop uses for that workspace; chat is part of the first shippable slice with pairing and the directory.
- **FR-009**: Where the product already exposes workspace agents or actions for a workspace, mobile MUST be able to trigger them for that workspace and persist results on the workspace shared with desktop; agents MAY ship after the chat path within this feature.
- **FR-010**: Every mobile read and write MUST be scoped to the paired person; another person’s identifiers MUST NOT leak data.
- **FR-011**: The mobile companion MUST be delivered as a separate mobile web experience (usable in a phone browser), not as a native app store binary and not as a clone of the Chrome Side Panel or desktop Home chrome.
- **FR-012**: Mobile MUST NOT move, group, open, or close Chrome tabs on the desktop browser; browser control remains a desktop/extension concern.
- **FR-013**: Unpaired or revoked mobile sessions MUST be refused clearly and MUST NOT show another person’s or stale privileged workspace data.
- **FR-014**: When voice is available, mobile workspace chat MUST allow the person to hear assistant replies as speech and MAY allow spoken questions that become normal text messages in the same workspace conversation; text remains authoritative.
- **FR-015**: Missing or failed voice MUST NOT prevent pairing, directory browsing, or typed chat.

### Key Entities

- **Person**: The account identity shared by desktop and mobile devices.
- **Device**: A paired client (desktop extension or mobile companion) belonging to one person; can be revoked independently.
- **Pairing offer**: Short-lived, single-use link between an unbound mobile session and a person; represented as code and QR.
- **Workspace**: Same durable unit as desktop (pages, chat, plan/agent results); mobile is another view of it.
- **Workspace conversation / agent run**: Existing workspace-scoped artifacts visible from mobile when the product already has them.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A person who already uses desktop can complete phone pairing (code or QR) in under 2 minutes on a first attempt.
- **SC-002**: After pairing, 100% of that person’s named workspaces visible on desktop Home appear in the mobile directory (same names; no extras invented only for mobile).
- **SC-003**: A membership or rename change made on desktop is visible on mobile within one refresh (or under 30 seconds if the companion auto-updates).
- **SC-004**: A chat message sent from mobile for a workspace appears in that workspace’s history on desktop after reload, and the reverse also holds. This is required for the first shippable slice along with SC-001–SC-003 and SC-005–SC-006.
- **SC-005**: On a phone-sized viewport, the primary path pair → list → open workspace can be completed without pinch-zoom or horizontal scrolling of the main chrome.
- **SC-006**: An expired or revoked device cannot list workspaces or send chat; attempts fail with an understandable unpaired/revoked state at least 99% of the time in manual checks.
- **SC-007**: When voice is configured, a person can hear at least one chat reply on mobile in under 10 seconds from choosing “listen,” and the same reply remains in text history on desktop.

## Assumptions

- First shippable slice: pairing + directory + workspace chat. Agents (US3b) and light voice (US5) ship later in the same feature and MUST NOT block that slice.
- Pairing offer lifetime defaults to about 5 minutes.
- Pairing UI on desktop defaults to Home (not required in the Side Panel for MVP of 014).
- A person may pair a small number of mobile devices (default ceiling: 3); additional pairs require revoking one.
- Voice playback defaults to explicit tap-to-listen (no auto-play of new replies).
- MVP cut-line desktop features that own workspaces, pairing tokens, chat, and agents (as applicable) already exist or ship before this companion is required for demo; mobile reuses that shared state rather than inventing a second backend.
- “Separate mobile web app” means its own mobile-oriented URL/experience; it may share the same product backend as desktop.
- Pairing is preferred over full email/OAuth login for this stretch feature; account login can come later without changing the workspace model.
- Default when a phone is already paired and a new code for a different person is scanned: refuse until the existing device is revoked (avoids silent account switching).
- Light ElevenLabs-style voice on mobile (hear replies; optional speak-to-ask) is in scope as a soft P3: same workspace chat as text, never a separate agent, and never required for pair/list/typed chat.
- Desktop voice feature (013) is helpful but not required; mobile may ship voice independently if credentials exist.
- Native iOS/Android store apps are out of scope; a mobile browser (and optional “add to home screen”) is enough.
- Mobile does not need to recreate organize/drag-and-drop of Chrome tabs; desktop remains the place for browser-side organization.
