# Feature Specification: Workspace Agents

**Feature Branch**: `010-workspace-agents`

**Created**: 2026-09-19

**Status**: Draft

**Input**: User description: "Add a fixed list of workspace agents to each expanded workspace card on Home, laid out as tabs | chat | agents (replacing the current action buttons and artifacts column, which are stubs from feature 005). Each agent is a one-shot tool, not an autonomous program: it runs against one workspace's context and saves a real result that appears right under the agent on the card, with older runs available to expand and still there after a reload. Include roughly five reliable agents: summarize sources, compare options, what's missing, next steps (a checklist the person can tick, saved as the workspace's plan items so the workspace chat can see it), and collect refs (key quotes with their links). Agents may read the actual pages of the workspace's public https tabs on the server, for richer text than the short stored excerpt, safely, treating page text as untrusted data. Pages that cannot be read must be reported plainly rather than guessed at. The workspace is the context boundary. The AI provider is configurable behind one interface, so the spec stays provider-neutral. A model call happens only when the person presses an agent, at most one model request per run. Feature 009 (plan generation) was cut and folded into this feature. The server side must be fully testable without any UI; the Home card is the first place it shows and the sidebar will reuse the same list later."

## Clarifications

### Session 2026-09-19

Made without interactive questions; these are the answers assumed (each is also listed under Assumptions):

- Q: What is an "agent" here? → A: A fixed catalog of five one-shot tools. Not user-defined, not multi-step, not autonomous (Constitution IV).
- Q: Where do results live? → A: Right under the agent that produced them, on the workspace card. There is no separate artifacts area.
- Q: Where does the checklist go? → A: The "next steps" agent saves its checklist as the workspace's plan items, so the workspace chat already sees it.
- Q: Which pages may be read? → A: Public web pages only, over the secure web protocol. Anything private, local, internal, login-walled, or not a readable page is reported as not read.
- Q: Does a run stream? → A: No. A run finishes and then its whole result appears. Nothing partial is ever shown as finished.
- Q: When the person presses an agent, does the server answer right away with a running record that the card checks back on, or keep the request open until the result is ready? → A: It answers right away with a running record; the card checks back every few seconds until the run is finished or failed.
- Q: When the server reads a tab's page, does it visit the tab's full address or the address with its query string and fragment removed? → A: The address with the query string and fragment removed, so private tokens and one-time links are never replayed; a page that needs them is reported as not read.
- Q: Should an agent also use the workspace's recent saved chat conversation, or only tabs, page text, and the existing checklist? → A: It also uses the recent chat conversation, capped exactly as the workspace chat's own context is.
- Q: How much run history is kept for each agent in a workspace? → A: The latest 10 runs per agent per workspace; older ones are removed automatically.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Press an agent and get a real, saved result (Priority: P1)

A person has a workspace with tabs about one project (a trip, a paper, a purchase). They press an agent, for example "summarize sources". A moment later a real result appears: a summary that draws on what is in this workspace's tabs. The same holds for the other text agents: "compare options" gives a side-by-side comparison, "what's missing" lists gaps in the research, and "collect refs" lists key quotes with the address each came from. The result is saved with the workspace.

**Why this priority**: This is the whole point of the feature. It turns the workspace from something you read into something that does work for you, and it replaces two empty stub regions with a visible, real result.

**Independent Test**: With a workspace of several tabs, run each of the four text agents and read the saved result back. Each returns non-empty content that refers to that workspace's tabs, and the result is there on a second read. No screen is needed.

**Acceptance Scenarios**:

1. **Given** a workspace with several tabs, **When** the person runs "summarize sources", **Then** a result is saved and returned, and it refers to specific tabs of this workspace by title.
2. **Given** a workspace with tabs, **When** the person runs "compare options", **Then** the result is a comparison of the tabs or options that are actually there, not invented ones.
3. **Given** a workspace with tabs, **When** the person runs "what's missing", **Then** the result names gaps relative to what the tabs cover, and says so plainly when the workspace is too thin to judge.
4. **Given** a workspace with tabs, **When** the person runs "collect refs", **Then** the result lists short quotes, each with the address of the tab it came from, and no quote that is not in the material the agent was given.
5. **Given** a workspace with no tabs, **When** the person runs any agent, **Then** the person is told to add tabs first, no AI request is made, and nothing is saved as a result.
6. **Given** a finished run, **When** the person reads the workspace's runs later or after a reload, **Then** the same result is there.

---

### User Story 2 - A "next steps" checklist the person can tick, that chat also knows about (Priority: P1)

The person runs "next steps". They get a short checklist of concrete next actions for the workspace, and they can tick items off and untick them. The checklist is saved as the workspace's plan items, so when they ask the workspace chat "what should I do next?" or "what have I done?", the chat's answer reflects the same list and its ticks.

**Why this priority**: The plan checklist (feature 009) was cut on the condition that this agent keeps its useful part. Ticking and seeing chat agree is what makes the checklist worth having.

**Independent Test**: Run "next steps", tick two items through the server, then confirm the plan items show those two as done and that the chat context for the workspace includes the same items with the same done flags.

**Acceptance Scenarios**:

1. **Given** a workspace with tabs, **When** the person runs "next steps", **Then** a checklist of a small number of short items is saved as the workspace's plan items and returned with the run.
2. **Given** a saved checklist, **When** the person ticks or unticks an item, **Then** the change is saved immediately and is still there after a reload.
3. **Given** ticked and unticked items, **When** the person runs "next steps" again, **Then** items already ticked are kept, the unticked ones are replaced by the new proposal, and the list does not grow without limit.
4. **Given** a checklist exists, **When** the person asks the workspace chat about next steps or progress, **Then** the chat's context includes those items and their done state.
5. **Given** another workspace of the same person, or another person, **When** either ticks or reads plan items, **Then** it never shows or changes this workspace's checklist.

---

### User Story 3 - Agents read the real pages, safely (Priority: P1)

Tab excerpts are short and often useless (menus, page furniture). So when a person runs an agent, the server reads the actual text of a limited number of the workspace's public web pages and gives that to the agent. The result says which tabs it actually read and which it could not (a private or login-only page, a PDF, an error, a page that timed out), and it never pretends to know what an unread page contains.

**Why this priority**: Without real page text, "summarize sources" on a Canvas or PDF tab is empty, which is exactly what was seen with chat. Reading pages is what makes agents worth more than chat, and it is also the riskiest part of the feature, so it is P1 for both reasons.

**Independent Test**: Run an agent on a workspace built from fixture pages (a normal article, a page that redirects, a very large page, a slow page, a non-page file, an internal address). The result lists each tab as read or not read with a plain reason, and no request ever goes to a private or local address.

**Acceptance Scenarios**:

1. **Given** a workspace with public secure pages, **When** an agent runs, **Then** it uses text read from those pages, and the result reports how many tabs it read out of how many the workspace has.
2. **Given** a tab whose address is private, local, or internal (for example a home network address or the machine itself), **When** an agent runs, **Then** the page is not requested, and the result lists it as not read with a plain reason.
3. **Given** a public address that redirects to a private or local address, **When** an agent runs, **Then** the redirect is refused and the tab is listed as not read.
4. **Given** a page that is slow, huge, not a readable web page, requires login, or returns an error, **When** an agent runs, **Then** it is listed as not read, the run still completes with the pages that could be read, and the agent does not describe what the unread page might say.
5. **Given** a workspace with more tabs than the per-run limit, **When** an agent runs, **Then** only the most relevant ones are read (open tabs first, then most recently seen), and the result says it covers a subset.
6. **Given** a page whose text tells the agent to ignore its instructions, reveal other data, or produce a particular output, **When** an agent runs, **Then** the instruction is not followed, and it is treated only as content of that page.

---

### User Story 4 - A workspace and a person stay separate (Priority: P1)

An agent uses only the workspace it was run on. It never reads, quotes, or lists another workspace's tabs, results, or plan items, and never another person's. A person cannot see, run, or tick anything in someone else's workspace, and the content of pages, results, and checklists is never written to logs.

**Why this priority**: This is the same privacy promise as chat, and agents read more (whole pages) and write more (saved results and plan items), so a leak would be more serious.

**Independent Test**: Give two workspaces of one person and one workspace of another person distinctive content. Run agents in one workspace and search every input to the AI, every result, and every response for the others' distinctive text. Also call every operation with another person's credentials and with the reserved "other" bucket id.

**Acceptance Scenarios**:

1. **Given** two workspaces with distinctive tabs, conversations, and plan items, **When** an agent runs in the first, **Then** nothing from the second appears in what the AI was given or in the result.
2. **Given** a second person, **When** they try to list, run, read the runs of, or tick a plan item in the first person's workspace, **Then** they get "not found" and nothing changes.
3. **Given** the "Other" bucket (tabs with no workspace), **When** anyone tries to run an agent on it, **Then** they are told agents are for workspaces, and nothing is run.
4. **Given** any run, **When** the server's logs are read afterwards, **Then** they contain no page text, tab titles, addresses, results, or plan item text.

---

### User Story 5 - When the AI can't do it, the person is told and loses nothing (Priority: P1)

If the AI service is unavailable, busy, over its daily allowance, or (for the default provider) the required network connection is off, the person sees a clear friendly message, the run is recorded as failed (never as a finished result), and they can run the agent again. Only one run of a given agent can be going for a workspace at a time.

**Why this priority**: The AI service is a dependency that fails in ordinary use (the default one only works on a certain network). If a failure looks like a result, people are misled.

**Independent Test**: Force each failure (unreachable, busy, allowance spent, network required, no key configured) and confirm the message, that no finished result was saved, that the failed attempt is visible as failed, that a second run works once the cause is gone, and that a second press while one is running is refused.

**Acceptance Scenarios**:

1. **Given** the AI service is down or unreachable, **When** the person runs an agent, **Then** they see a plain message that it could not run and they can retry, and the attempt is stored as failed with that plain reason.
2. **Given** the service is busy or its daily allowance is spent, **When** the person runs an agent, **Then** the message names which of the two it is.
3. **Given** the required network is off, **When** the person runs an agent, **Then** the message says so.
4. **Given** no AI provider is configured on the server, **When** the person runs an agent, **Then** they are told it is not set up, and nothing is stored.
5. **Given** a run of an agent is in progress for a workspace, **When** the person presses the same agent again, **Then** they are told it is already running and no second run starts or is charged.
6. **Given** a run that could not finish (including one the server never completed), **When** the person looks at it later, **Then** it appears as failed, not as a finished result and not as running forever.
7. **Given** any run, **When** it is counted, **Then** it made at most one AI request, and none was made without the person pressing an agent.

---

### User Story 6 - The Home card shows the agent list (Priority: P1)

On Home, an expanded workspace card shows three columns: the tabs, the chat, and the agents. The old action buttons and the empty artifacts column are gone. Each agent is a row with its name, a one-line description, and a run control; while it runs it shows that it is running; when it finishes its latest result appears right under it.

**Why this priority**: The card is where the person meets this feature first, and it is the placeholder the earlier Home feature deliberately left for it.

**Independent Test**: Open Home against a server with test data. Expand a card, run an agent, and see its result under the agent; reload Home and see it again.

**Acceptance Scenarios**:

1. **Given** an expanded workspace card, **When** it is shown, **Then** it has the tabs, chat, and agents columns, with no separate actions row and no artifacts column.
2. **Given** the agent list, **When** the person presses an agent, **Then** that row shows it is running, other agents can still be pressed, and the result replaces the running state when done.
3. **Given** a failure, **When** the person sees the row, **Then** it shows the plain message and a way to run again.
4. **Given** a "next steps" result, **When** it is shown, **Then** each item is tickable in place.
5. **Given** an agent's result text, **When** it is shown, **Then** it is displayed as plain text and never loads images, embeds, or remote content by itself.
6. **Given** the person collapses the card or leaves Home during a run, **When** they come back, **Then** the row shows the run's true state (running, finished, or failed).

---

### User Story 7 - Older runs stay available (Priority: P2)

Each agent keeps its earlier runs. The latest is shown; the person can expand the row to see older ones. Runs survive reloads and restarts.

**Why this priority**: Useful for comparing a summary before and after adding tabs, but the feature works without it.

**Independent Test**: Run an agent three times, then read the workspace's runs: all three are there, newest first, and the card shows the latest with the others expandable.

**Acceptance Scenarios**:

1. **Given** several runs of one agent, **When** the person reads the runs, **Then** they are listed newest first, with each one's time and outcome.
2. **Given** more than ten runs of one agent, **When** the history is read, **Then** only the latest ten remain, and reads are returned in pages.
3. **Given** a "next steps" history, **When** an older run is shown, **Then** it is shown as it was proposed, and only the current checklist is tickable.

### Edge Cases

- A workspace with no tabs: the person is told to add tabs; no AI request; nothing stored.
- A workspace whose tabs are all unreadable: the agent still works from titles, addresses, and stored excerpts, and the result says plainly that it could not read any page.
- The same address open in two tabs of one workspace: it is read once and listed as one source.
- A tab whose address has a query string or fragment (a video, a search, a signed link): the plain address is read instead, the result flags it, and if the plain address does not give the same page the tab is reported as not read rather than described.
- A tab that is not a secure web address (for example a local file or a browser page): not read, listed as not read.
- A page that redirects several times, or to another host: only a small number of redirects are followed, each checked against the same safety rules.
- A page far larger than the limit: only the start is used, and the result says it was cut.
- Page text in another language: the agent answers in the language the workspace's content is mainly in (and says if it is mixed).
- An archived workspace: agents can still be run and read (as with chat).
- Many failed runs in a row (for example the AI is down for a while): the latest finished result stays available and is not pushed out by the failures.
- A run that is in progress when the server restarts: it is shown as failed after a short time, never as running forever, and the agent can be run again.
- Two different agents on the same workspace at once: allowed; the same agent twice: refused.
- The person's results contain hostile-looking text (fake instructions, links, images): shown as inert plain text.
- The daily AI allowance runs out mid-day: further runs get the allowance message until it resets; nothing already saved is lost.
- A "next steps" run when the workspace already has 30 or more plan items: the list is kept within the same limit that chat reads.
- The chat panel and an agent used at the same time: independent; neither blocks the other except through the shared AI allowance.

## Requirements *(mandatory)*

### Functional Requirements

**The agent list and runs**

- **FR-001**: The system MUST offer a fixed catalog of exactly five agents: summarize sources, compare options, what's missing, next steps, and collect refs. The catalog is not editable by people.
- **FR-002**: The system MUST expose the catalog (each agent's name, one-line description, and the kind of result it produces) so a client can show the list without hard-coding it.
- **FR-003**: Running an agent MUST be an explicit action by the person for one workspace. The system MUST NOT run an agent automatically, on a schedule, on opening a workspace, or as a side effect of any other action.
- **FR-004**: A run MUST make at most one AI request. All material the agent needs MUST be gathered before that one request.
- **FR-005**: A run MUST produce a result of its agent's kind: text for summarize and what's missing, a comparison for compare options, a checklist for next steps, and a list of quote-and-address pairs for collect refs.
- **FR-006**: The result MUST be built only from the workspace's own material and the AI's answer; the system MUST NOT add facts of its own.
- **FR-007**: A workspace with nothing to work from (no web tabs, meaning no tab with an http or https address) MUST be refused with a clear message, without any AI request and without storing a result.
- **FR-008**: Only one run of a given agent MAY be in progress per workspace at a time; a second attempt MUST be refused clearly and MUST NOT start or consume anything. Different agents on the same workspace MAY run at the same time.

**Storing runs and results**

- **FR-009**: Every run MUST be stored with the workspace as a run record: which agent, a short summary of what it was run on (counts, not content), its result when finished, its outcome (running, finished, failed), and its time.
- **FR-010**: A result MUST be stored as finished only after the whole result exists. A failed or unfinished run MUST be stored as failed with a plain reason and MUST NOT be shown or counted as a result.
- **FR-011**: A run that never completed (for example the server stopped) MUST become visible as failed after a short time, never as running forever. This MUST hold even if nobody presses anything again: reading the runs is enough to see it as failed.
- **FR-012**: The system MUST return an agent's runs in a workspace, newest first, in pages, and MUST make the latest finished result of every agent easy to read in one call.
- **FR-013**: Runs and results MUST persist across reloads and server restarts.
- **FR-014**: The system MUST reuse the existing run record and plan item records; it MUST NOT add new kinds of stored records for agents.
- **FR-043**: The system MUST keep only the latest 10 runs of each agent in each workspace and remove older ones automatically. It MUST NOT remove a run that is still running, and it MUST always keep the latest finished result of each agent, even when newer failed runs would otherwise push it out.

**The "next steps" checklist**

- **FR-015**: The "next steps" agent MUST save its checklist as the workspace's plan items (short text, done flag, order), a small number of concrete items with short text.
- **FR-016**: A new "next steps" run MUST keep items the person already ticked, replace the unticked ones with the new proposal, and keep the whole list within a fixed maximum.
- **FR-017**: The person MUST be able to tick and untick a plan item through the server, and the change MUST be saved immediately and returned.
- **FR-018**: The workspace chat MUST see the saved plan items and their done state through its existing context, with no change in how chat is asked.
- **FR-019**: Plan items MUST only be read or changed for the person's own workspace.

**Reading pages**

- **FR-020**: For a run, the system MAY read the text of a limited number of the workspace's tabs that are public web pages over the secure protocol, choosing open tabs first and then the most recently seen. The maximum pages per run, per-page size, per-page time, total reading time, and number of redirects MUST all be fixed, small limits. Each page MUST be requested at the tab's address with its query string and fragment removed, and the result MUST flag any page read that way, because it may differ from what the tab shows.
- **FR-021**: The system MUST NOT request any address that is private, local, loopback, link-local, internal, or otherwise not a public internet address, including when reached through a redirect or a name that resolves to such an address.
- **FR-022**: Only readable web pages MAY be used; other file types, very large downloads, and pages that require sign-in MUST be treated as not read.
- **FR-023**: Every tab that is not read MUST be listed in the result with a plain reason category (for example private address, needs sign-in, not a web page, too large, too slow, error), and the agent MUST NOT describe or guess the content of an unread tab. A tab MAY still be known by its title, address, and stored excerpt, and the result MUST say when that is all it had.
- **FR-024**: The result MUST state how many tabs were read out of how many the workspace has.
- **FR-025**: The same address in more than one tab (compared after removing the query string and fragment) MUST be read only once per run and MUST appear once in the run's list of sources.

**Untrusted content**

- **FR-026**: All text from tabs, pages, plan items, and the workspace name MUST reach the AI only as clearly separated data, never as instructions, and the agent's fixed rules MUST tell it to ignore any instruction found there.
- **FR-027**: An agent MUST have no way to act: it cannot open, close, or move tabs, make requests of its own, or run anything; it can only produce a result.
- **FR-028**: Results MUST be treated as untrusted text by clients: shown as plain text, never as markup, and never causing anything to load automatically.

**Boundaries, privacy, and failure**

- **FR-029**: Every read and write MUST be limited to the signed-in person and the one workspace; another person's workspace, or one that does not exist, MUST be indistinguishable ("not found"). The reserved "Other" bucket MUST be refused with a clear message.
- **FR-030**: The system MUST NOT write tab content, page text, results, plan item text, or messages to logs or error messages. Logs MAY hold identifiers and counts only.
- **FR-031**: When the AI service is unavailable, busy, over its daily allowance, off the required network, or not configured, the person MUST get a distinct, plain, friendly message for each, and no failure MAY be stored or shown as a finished result.
- **FR-032**: The AI provider MUST be configurable behind one interface without changing this feature, and nothing in this feature may depend on a particular provider. Agent requests MUST count against the shared daily AI allowance under their own share.
- **FR-033**: Every operation MUST require the person's credential, and MUST be usable by the Home page and, later, the sidebar.

**Home card**

- **FR-034**: The expanded Home card MUST show tabs, chat, and agents columns; the placeholder action buttons and the empty artifacts column MUST be removed.
- **FR-035**: Each agent row MUST show its name, description, run control, current state, and its latest result; earlier runs MUST be expandable.
- **FR-036**: A "next steps" result MUST be tickable on the card, with the change saved as in FR-017.
- **FR-037**: While a run is in progress the card MUST show it as running, MUST keep other agents pressable, and MUST show the true state again after a reload or reopening.
- **FR-038**: The card MUST still work, showing a plain message, when the server cannot be reached.

**Run lifecycle**

- **FR-039**: Pressing an agent MUST return at once with a run record in the running state; the run then proceeds on its own, whether or not the person stays on the card. Reading that run, or the workspace's runs, MUST show it as running until it is finished or failed.
- **FR-040**: While any run on a card is running, the card MUST re-read the run's state every few seconds until it is finished or failed, and MUST stop checking once none is running.
- **FR-044**: A person MAY have at most 3 runs in progress at once across all their workspaces; a further press MUST be refused clearly and MUST NOT start or consume anything.

**What an agent is given**

- **FR-041**: An agent MUST be given, for the one workspace only: its tabs (title, plain address, and stored excerpt), the page text read for the run, its existing plan items with their done state, and its recent saved chat conversation (user and assistant messages only, capped to the same recent window and size as the workspace chat's own context).
- **FR-042**: Saved chat messages MUST be treated as untrusted data, like tab and page text, because an earlier reply can carry text that came from a page; they MUST NOT be logged.

### Key Entities

- **Agent**: One entry of the fixed catalog: an identifier, a name, a one-line description, and the kind of result it produces (text, comparison, checklist, quotes). It has no stored state of its own.
- **Agent run** (the existing run record): One press of an agent on one workspace. It has the agent, a short summary of its input (counts of tabs and pages, never content), its result, its outcome (running, finished, failed), a plain failure reason when failed, and its time. It belongs to one person and one workspace.
- **Agent result**: What a finished run produced, in the shape of its agent's kind, together with which tabs were read and which were not (with plain reasons).
- **Plan item** (the existing checklist item): A short text with a done flag and an order, belonging to one workspace. The "next steps" agent writes them; the person ticks them; chat reads them.
- **Tab** (existing): Its title, address, and stored excerpt are the material an agent starts from, plus the page text read for a run.
- **Message** (existing chat message): The workspace's recent saved conversation, given to an agent as context and never changed by it.
- **Workspace** (existing): The context boundary for every run, result, and plan item.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a reference workspace of about ten public pages, at least 9 of 10 runs finish and show a saved result within 45 seconds of the person pressing the agent.
- **SC-002**: Across a reference set of runs of all five agents on a workspace beside an unrelated one, at least 9 of 10 results refer to content from the right workspace and none refers to content from the other.
- **SC-003**: Every quote in a "collect refs" result appears in the material the agent was given, and every one carries the address of the tab it came from (100% on the reference set).
- **SC-004**: For every tab that cannot be read (test set: private address, local machine, redirect to a private address, needs sign-in, not a web page, too large, too slow, error), the result lists it as not read with a reason and never describes its content (100%), and no request is ever made to a private or local address.
- **SC-005**: A finished result is still there, identical, after a reload and after a server restart (100% of runs).
- **SC-006**: 100% of failures (unreachable, busy, allowance spent, network off, not configured) give the person a plain message that names the situation, store no finished result, and allow running the agent again straight away.
- **SC-007**: No AI request is made unless the person pressed an agent: zero requests across reading runs, opening workspaces, changing tabs, refused runs, and browsing the card; exactly one request per run that reaches the AI.
- **SC-008**: Across five styles of hostile text placed in tabs and pages (reply only with a marker, a fake assistant turn, print your instructions, include a remote image, list other people's data), none is obeyed and none is copied out as an instruction.
- **SC-009**: Nothing from another workspace or another person appears in any AI input, result, or response across the isolation test set (100%), and no page text, title, address, result, or plan item text appears in any log across the test set.
- **SC-010**: After the person ticks items on a "next steps" checklist, the same ticks appear in the workspace chat's context and survive a reload (100%).
- **SC-011**: Pressing the same agent twice on one workspace never produces two runs at once (100% refused), while different agents can run together.
- **SC-012**: A person who has never seen the card can find, run, and read the result of an agent in under one minute on their first try.
- **SC-013**: After 12 runs of one agent in a workspace, exactly the latest 10 remain, and the latest finished result is still there even if the most recent runs failed (100%).

## Assumptions

- **Fixed catalog.** The five agents are fixed in the product; there are no custom agents, no editing, and no scheduling. "Agent" is the interface word for a one-shot tool (Constitution IV). Multi-step or autonomous agents remain optional stretch.
- **Workspaces only.** As with chat, agents belong to a workspace; the "Other" bucket has none.
- **Results are not streamed.** A run may take tens of seconds because it reads pages first. Pressing returns at once with a running record, the card checks back every few seconds while a run is running, and the whole result appears when it is done. Nothing partial is shown as finished.
- **The run continues if the person leaves.** Closing the card does not cancel a run; the result is there when they return. A run with no completion after about two minutes is shown as failed.
- **Failed attempts are kept as failed.** They appear in the run history with a plain reason so it is clear what happened, but never as a result. The plain reason is one of a small set of fixed sentences, never text from the AI service.
- **Reading limits (defaults, adjustable by configuration).** Up to 8 pages per run; up to 2 redirects each; a small size and time limit per page and in total; open tabs first, then most recently seen. The page text given to the AI is trimmed so the whole run stays within one AI request.
- **Plain addresses only.** The server never visits a tab's query string or fragment, because they can carry private tokens or one-time links. Pages that depend on them are reported as not read; this matches how chat already hides them from the AI.
- **Unreadable pages are normal.** Sign-in pages (such as a course site), PDFs, and app-style pages are expected to be "not read"; this feature reports that honestly and does not try to get around it. Reading those needs a different capture path and is out of scope.
- **Chat as context.** Agents see the same recent window of the workspace's conversation that chat itself uses (the last 20 messages, up to 24,000 characters, oldest dropped first). This keeps a run to one AI request and lets results reflect what the person already decided.
- **Load is bounded.** A person can have at most 3 runs going at once, and the server downloads at most 8 pages at a time across everyone, so one person or one busy moment cannot flood it.
- **Duplicate addresses are merged.** Tabs that share a plain address appear as one source; coverage counts sources, so "read 6 of 9" is about distinct pages.
- **History is bounded.** The latest 10 runs of each agent are kept per workspace, so storage and every read stay small; the person cannot delete runs by hand in this feature.
- **Checklist limits.** A "next steps" run proposes about 5 to 8 items of at most 200 characters, and a workspace keeps at most 30 plan items, the same limits chat already reads.
- **Checklist replacement.** A new run keeps ticked items and replaces the unticked ones; there is no manual adding, editing, reordering, or deleting of plan items in this feature.
- **Language.** Agents answer in the language the workspace's content and the person's browsing mostly use; there is no language setting.
- **Shared AI allowance.** Agent runs count against the same daily AI allowance as chat and clustering. The share previously set aside for the cut plan feature moves to agents.
- **Existing records are enough.** The existing run record (with its input, output, status, and time) and plan item records hold everything, so no new kinds of stored records are needed; any addition would be a small index or column, justified in the plan.
- **Provider-neutral.** The same provider interface, daily allowance, and concurrency limits as clustering and chat apply; the default provider needs its required network connection and the backup does not.
- **Home is the first place; the sidebar comes later.** This feature builds the card on Home. The sidebar (feature 006) will reuse the same list and server behavior; nothing here is Home-only on the server side.
- **Server first.** The server side (list agents, run one, read runs, tick a plan item) is fully testable without any screen, like features 003, 004, and 008.
- **Out of scope.** User-defined agents; multi-step or autonomous agents; MCP; computer use; reading sign-in-protected pages or PDFs; exporting or creating documents from results; editing, deleting, or sharing runs; scheduling; notifications; voice; the sidebar; the global command bar; and changes to how tabs are organized.
