# Changelog

All notable changes to EmperorClaw are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

At release time, rename the `## [Unreleased]` heading below to the version being
tagged (e.g. `## [1.2.0] — 2026-07-22`). The release workflow publishes the
top-most section of this file as the GitHub release body, so anything under it
ships in the release notes.

## [0.8.85] — 2026-10-10

### Changed
- Codex agents now accept sibling mentions and handoffs. The Codex bridge sends its bound `agentId` on `/messages/sync` and follows the server's authenticated `addressedToYou` verdict for agent messages too (a mentioned peer or an explicit pair handoff responds). Loop-paused, not-addressed and own messages still skip, and on a legacy server with no verdict agent messages fail closed — so per-thread loop guards are unchanged and an agent's `@all` never fans out to other agents.

## [0.8.84] — 2026-10-10

### Fixed
- Interpret chat reply timestamps consistently in UTC so answered messages are not delivered again on servers with a different local timezone.
- Preserve pending human followups during chat synchronization and validate multi-turn routing under UTC and Europe/Bratislava.

## [0.8.83] — 2026-10-10

### Changed
- Prefer the shared team chat for agent-to-agent messages when one team is unambiguous, addressing the intended recipient without waking every teammate.
- Ask agents to choose a team when several are shared; preserve explicit conversation context and provide an explicit private handoff option.

### Fixed
- Require both sender and recipient to belong to an explicitly selected group, retaining private pair routing and loop safeguards.

## [0.8.82] — 2026-10-10

### Added
- Portable, provider-independent objectives. Emperor now owns the objective, sends the agent a private prompt on a fixed cadence up to a finite budget, and exposes an authenticated `update_objective` tool and `/api/mcp/objectives` route (bound to the agent's token) to update, pause, block, complete or cancel it. Works with every runtime that can receive and send messages.
- Tool-less fallback: an objective prompt also teaches one optional isolated `EMPEROR_OBJECTIVE_STATUS {…}` reply line, which the server acts on only for an authenticated agent reply to its own objective prompt (matching company, thread and objective id) and then strips from the visible transcript. This lets runtimes without Emperor tools — such as the Codex bridge — still complete or block an objective with a normal reply.
- A user-requested **Blocked** task state with a required reason. Blocked tasks stay visible but receive no automatic stalled-task reminders; unblocking clears the reason and restarts the progress clock.
- An accessible in-app "Block task" dialog (reason required) for both the task state selector and drag-and-drop.

### Changed
- Objectives started in the web UI or with `/goal` are anchored to the originating private conversation and are private to their creator and company owners/admins; other members see a redacted status.
- The Objective control shows objective, cadence and Start/Pause/Resume/Stop, without misleading native-turn configuration.

### Fixed
- Route agent-to-agent pair replies through their pair thread on every turn. A reply now carries its source message, and the server derives the thread from it instead of silently defaulting an agent's reply to its own operator DM.
- Blocked tasks are excluded from the stall sweep and daily review, while remaining visible and countable.

### Compatibility
- Old Hermes-native goal records and `/goal` commands remain readable and cancellable; new objectives never depend on a runtime goal manager.

## [0.8.81] — 2026-10-09

### Added
- Workspace setting to disable stalled task reminders independently of daily reviews and new task assignments.

### Fixed
- Preserve the reading position in group and direct messages during polling and incoming updates; stop automatic smooth scrolling while reading history.
- Keep loaded group history when conversation previews refresh.
- Encode group chat polling cursors consistently across server time zones.
- Group private stalled task reminders, apply recipient and escalation cooldowns, and prevent duplicate sweeps across server instances.

## [0.8.80] — 2026-10-09

### Fixed
- Provide the exact collapsed-navigation crown at the conventional favicon.ico URL, in 16, 32, and 48 pixel sizes.
- Version favicon references so browsers refresh previously cached icons.

## [0.8.79] — 2026-10-09

### Fixed
- Route multiword agent mentions correctly despite nonbreaking spaces, invisible format characters, fullwidth @ signs, and composed or decomposed accents.
- Recognize longer full names and reject ambiguous names without waking multiple agents.
- Apply the same Unicode handling to the Hermes fallback router while retaining server verdicts, group membership checks, and loop guards.
- Preserve original message text and conversation history during mention normalization.

## [0.8.78] — 2026-10-09

### Fixed
- Replace the obsolete favicon with the crown used in the signed-in navigation.
- Remove the legacy favicon assets and allow the crown to load before sign-in.

## [0.8.77] — 2026-10-09

### Added
- Visual organization editing through reporting nodes and avatar pickers, with dedicated AI team leaders and shared specialists.
- Edit team names and purposes or archive teams and chats directly from the organization chart.
- Visible task archiving on completed cards, with confirmation and retained history and files.

### Changed
- Responsive Settings navigation with clearly separated categories and a grouped selector on smaller screens.
- Theme-aware onboarding, organization pickers, and standardized member dialogs.
- Compact team reporting guidance distinguishes chat collaboration from management relationships.
- Starter teams and workspace knowledge include clearer filing and operating guidance.

### Fixed
- Team hiring and onboarding retries preserve existing workers and reuse complete group chats.
- Archiving a team removes its chart branch atomically while preserving agents and conversation records.
- Access-scope editing avoids stale data, and starter knowledge upgrades preserve private and edited content.
- Database defaults and message timestamps use the same UTC timeline.

### Compatibility
- Existing group conversations, memberships, and legacy organization configurations remain readable.
- New chart edits require dedicated AI team leaders; ordinary specialists can still work in multiple teams.
- Organization roles do not change permissions or automatically send messages.

## [0.8.76] — 2026-10-09

### Added
- Dedicated Agents → Organization page with a single company leader and flexible team branches.
- Team chats created with new teams, existing group reuse, shared agent memberships, and optional team coordinators.
- Agent-bound organization consultation endpoint and compact Hermes reporting guidance refreshed each turn.
- Onboarding initializes its leader and teams once without overwriting an existing organization.

### Changed
- Dashboard agent selection opens a focused work briefing, with current tasks, actionable decisions, recent exchanges and a primary chat action.
- Desktop side panel and mobile bottom sheet keep navigation and long content manageable.
- Organization editing lives on its own page, linked from Agents and the dashboard.

### Compatibility
- Migration 0055 adds a nullable company organization field; existing chats and memberships are retained.
- Update both app and Hermes runtime for reporting context. Older servers keep normal group messaging.
- Organizational roles do not grant permissions or trigger messages automatically.

## [0.8.75] — 2026-10-09

### Added
- Agent action menu and modal chat on the dashboard, using the shared Messages renderer.
- Editable team organization with shared agents, optional coordinators, and touch-friendly membership controls.
- Bounded native Hermes objectives with start, pause, resume and clear controls, persisted progress, and restart recovery.

### Changed
- Cleaner dashboard details, folded usage metrics, and restored lateral workstation consoles.
- Compact, folded message queues with readable prompt previews.
- Compact team context for Hermes without adding the full company structure to each prompt.

### Fixed
- Usage pricing resolution and clearer distinctions between missing reports, unpriced usage and estimates.
- Objective control isolation, private objective visibility, cancellation, and legacy message synchronization.

### Compatibility
- No database migration required. Existing groups retain their memberships and optional coordination.
- Update both the app and Hermes runtime to use native objectives. Other providers continue normal messaging.

## [0.8.74] — 2026-10-08

### Added
- Living Observatory dashboard with recognizable agent avatars, activity-driven motion, real communication previews, and the user's company name.
- Teams view that highlights overlapping memberships, optional human or agent coordinators, and agents without a team.
- Optional group coordinators through the UI, REST and MCP; Hermes receives group-scoped coordination instructions.
- Read-only agent conversation visibility toggle in Messages, remembered in the browser.

### Changed
- Onboarding assigns the Boss as coordinator when included and successfully created, while sharing specialists across teams.
- Scene seating is independent of team membership, supports large teams through pagination, and keeps status labels clear on mobile.
- Long Markdown replies become bounded scene previews with links to the full conversation.
- Group controls have larger touch targets and readable mobile inputs.

### Compatibility
- Existing groups remain unchanged unless a coordinator is selected. No database migration is required.
- Coordinator responsibilities grant no additional permissions and preserve project leads, approval rules and message routing.
- Existing runtimes continue receiving group messages; updating Hermes enables the new coordination context.

## [0.8.73] — 2026-10-08

### Added
- Avatar-based Pulse dashboard with shared ESP32 colors, paginated team views and mobile controls.

### Changed
- Human actions are separated from observations; approvals and connection status remain visible alongside ongoing work.
- Dashboard motion follows fresh activity, supports reduced motion and can be paused. Playful idle behavior is optional.

### Fixed
- False attention warnings from historical activity, private activity descriptions, viewer controls and quick-chat error recovery.

## [0.8.72] — 2026-10-08

### Added
- One-click Render deployment: a Blueprint that provisions managed Postgres, the app image and a Hermes worker, generating the required secrets automatically.
- Remote worker pairing for hosts without a Docker socket: a Hermes worker polls `POST /api/runtime/pair` until an agent is assigned, and its agent-bound token is delivered exactly once.
- Pair-thread views: the dashboard lists an agent's active pair conversations (counterpart, last message, related task), and Messages links a pair thread to the task it is about.
- Bridge priority queue: human DMs and approvals first (P0), then task wakes (P1), pair threads (P2) and room mentions (P3), with per-thread coalescing and age-based anti-starvation.

### Changed
- At most one worker can hold an agent: the database enforces the binding, and the LLM key only travels with a freshly minted token.
- A worker that lost its token or presents a revoked one is released or rotated instead of silently re-issued.

### Fixed
- The Messages chat rebuilt its transcript and jumped the scroll position on the 15s dashboard refresh; the transcript is now seeded once and kept current by the 5s poll.

## [0.8.71] — 2026-10-08

### Fixed
- The dashboard failed to load in production: the throughput query grouped by an expression Postgres considered different from the selected one. It now groups by the selected bucket.

## [0.8.70] — 2026-10-08

### Added
- Dashboard: spend today and this month against budget, team throughput (done in 24h and 7 days, median cycle time, blocked), and a "What's moving" feed of handoffs.
- Needs your attention: ordered by urgency, with inline Approve, Reject, Resume, Reassign and Restart.

### Changed
- Agent states on the dashboard are truthful: "Stuck" only for real problems, "Running late" for SLA breaches, "Hasn't started" for unclaimed work; stale incidents are ignored.
- List mode is a responsive table that fits its panel and collapses to cards on narrow screens.

### Fixed
- The watchdog now closes its own SLA and unclaimed incidents once the task moves on, and no longer re-raises them for deleted tasks.
- Horizontal overflow on the dashboard at tablet and phone widths.
- Pair-thread activity is only sent to owners and admins; the approvals, task and runtime-restart routes require a signed-in company member.

## [0.8.69] — 2026-10-08

### Added
- Agent teams: assigning or reassigning a task to an agent wakes it with a short brief, so work moves PM → dev → QA without @-tagging.
- Private two-way agent conversations (pair threads); owners and admins can read them.
- `add_task_note` MCP tool for handoff notes, progress and blockers.
- Stall sweep: an owner is nudged once and its lead escalated once when a task stops moving.
- Team doctrine: lead, member and group playbooks plus software, content and research templates; "Run an Agent Team" and "Doctrine Reference" docs.
- Existing companies get the new starter doctrine automatically when their starter notes are unedited; edited notes are kept and an update is suggested.

### Changed
- The loop guard now pauses only agent back-and-forth without progress, posts a notice with a Resume action, and never drops messages (rooms 12, agent pairs 30).
- The Hermes bridge sends its static prompt once per session, rotates team and group sessions, shows roles in the roster and lists each agent's open tasks.
- Assignees can start their own tasks in projects where only the lead changes status.

### Fixed
- Agent-to-agent direct messages no longer land in a human's DM thread or bypass the loop guard.

## [0.8.68] — 2026-10-07

### Added
- The dashboard is now a live isometric office: KPI row, agents placed in role zones, collaboration paths, a needs-your-attention panel, a work-in-motion board and an activity ticker.
- A pan/zoom camera on the office (drag, wheel or pinch, +/−/fit controls, keyboard; double-click centres an agent).
- The selected-agent card embeds a direct chat with the agent, with links to Messages and the agent page.
- Emperor Claw's own agent characters replace DiceBear everywhere. Looks are stored per agent (`avatar_appearance`); legacy DiceBear seeds are migrated and uploaded photos are kept.
- `GET /api/avatars/{agentId}` serves an agent's drawing as SVG for external clients (no metadata, cached).

### Changed
- Agents show what they are doing through small activity cues and eye expressions instead of body motion; animations are desynchronised per agent and pause when off-screen.
- The dashboard shows agents only; the Everyone/People/My work filter is gone.

## [0.8.67] — 2026-10-07

### Added

- Live Knowledge and Storage cards in chat: open the exact note/file, download stored files, and preview PNG/JPEG/GIF/WebP images.
- Native MCP list_storage_files discovery with real share URLs; Knowledge discovery, runtime reply guidance, and MCP documentation explain how to present sources and deliverables.
- Company-scoped lookups preserve private human-upload visibility and show unavailable records without exposing metadata.

## [0.8.66] — 2026-10-07

### Fixed

- Allow twelve agent turns in shared conversations and automatically reset loop protection after five minutes of inactivity. Human messages still reset it immediately.
- Restore the incomplete /scene route by redirecting to the dashboard.
- Keep unchanged direct messages stable during polling and scroll only when a new message arrives or the user requests it.

## [0.8.65] — 2026-10-05

### Added

- **Desk display.** Firmware for the ESP32-2424S012C round 240×240 screen
  (`devices/throne-display/`) that shows your agents live: a pixel-art throne
  room, a focus page per agent with your private chats, a health radar and a
  message feed.
- **Set up a display from the browser.** Settings → **Displays** (admins, in
  Chrome or Edge): plug the display in over USB, install the firmware, pick
  your Wi-Fi from the networks the display can see, and finish. A read-only
  token is created and handed to the display without being shown. The tab also
  lists display tokens and revokes them.

### Security

- The display verifies TLS certificates, protects its setup Wi-Fi with a
  random password shown only on its screen, and erases its token if the server
  address is changed without a new one.

## [0.8.64] — 2026-10-05

### Added

- **Your private chats on a desk screen (opt-in).** When creating a
  **Read only** API token you can tick **Include my private chats**. The live
  feed (`GET /api/mcp/live`) then carries a `dm` array with your own recent
  exchanges with each agent: your messages and the agent's replies to you,
  never other members' messages. Typing activity text is shown only when the
  agent is working on your message. Off by default.

### Changed

- API tokens now record who created them. A screen loses the private chats
  when its creator leaves the company or is no longer an owner or admin.

## [0.8.63] — 2026-10-05

### Added

- **Read-only API tokens for screens and dashboards.** Settings → API tokens
  has a new **Read only (screens & dashboards)** scope. A read-only token can
  only call `GET /api/mcp/live`; it cannot send messages, create tasks or change
  anything, and every other endpoint refuses it.
- **Live agent feed, `GET /api/mcp/live`.** One compact JSON response with each
  agent's health, state (typing, working, idle, offline), live activity text and
  current task, the latest team and group messages, and pending approvals.
  Private direct threads are never included. It supports `If-None-Match`, so an
  unchanged poll returns `304`. First consumer: the ESP32 round desk display.

### Security

- Tokens whose stored scope is not recognised are now refused instead of being
  treated as full access.

## [0.8.62] — 2026-10-06

### Added

- **Team templates in Emperor setup.** The team step now offers ready-made
  teams you can combine: Development (developer, QA tester), Marketing &
  content (writer, SEO), Sales & outreach (outreach, writer), Customer support,
  and Finance & reporting (accountant, analyst). Each brings its specialists and
  its own group chat with an icon and purpose; the Boss leads and joins every
  group, and you are in each one. Teams are suggested for your kind of company,
  a role shared by two teams is one agent in both groups, and you confirm or
  change every name, remove anyone, or add single specialists before anything
  is created. Agents and group chats are then created in one go (up to eight
  agents, with a warning above four for small machines).

## [0.8.61] — 2026-10-05

### Changed

- **A more compact sidebar.** The logo is smaller and no longer sits in a
  card, menu items are tighter, and Documentation, theme, and Collapse are now
  small icons on one line next to the version instead of full rows, so the
  whole menu fits without scrolling on a laptop screen.

### Fixed

- On phones, the user card in the sidebar no longer squeezes your name past
  the edge; it shows your initial.

### Removed

- The outdated copies of the documentation under `docs/` (the app's
  documentation lives in `src/content/docs`), an unused docs landing page, an
  old first-agent guide, and an internal draft. The README now links to the
  current pages.

## [0.8.60] — 2026-10-05

### Fixed

- **Light mode.** Text that vanished or was hard to read in light mode now
  reads in both themes:
  - documentation body text, tables, and code blocks;
  - primary buttons ("Send Invitation", "Save"…), whose text was near-white;
  - pale accent text (green, amber, red, violet badges and labels), which now
    gets readable deep tones in light mode, the same way grays already did;
  - hover states that turned text white, card and input borders that were
    invisible on white, and boxes hard-coded to black in Settings;
  - the sign-in and public pages, which are designed dark and now always use
    the dark palette.
- **Dropdowns.** Native dropdown options follow the theme instead of showing
  light text on a light list (or the reverse).
- **Docs callouts.** `[!IMPORTANT]`, `[!TIP]`, `[!WARNING]` and `[!CAUTION]`
  render as their own callouts instead of a "Note" with the marker visible.
- **Docs navigation.** Three sidebar entries pointed at pages that no longer
  exist, newer pages (such as *Send Work From Your Platform*) were missing from
  the sidebar, and the "v1.0" version had no pages. The sidebar now lists every
  page by section, and a test keeps the nav, the files, and the links between
  pages in sync.

### Changed

- **Documentation brought up to date:** the overview describes the setup
  assistant and the current menu, and links to current pages; the Agent
  Operating Manual covers working a request, approvals, the daily review,
  requests from other platforms, routing, and memory; outdated version stamps
  and the old "Settings → Tokens" name are gone.

## [0.8.59] — 2026-10-05

### Added

- **Agent memory that works.** Hermes agents now see their memories at the
  start of every turn and save new ones with the `emperor_remember` tool when
  someone tells them how they want things done. In **Agents → Memory** you can
  teach an agent something or delete what it got wrong.
- **Avatar styles.** Click an agent's picture to choose from twelve DiceBear
  styles, shuffle it, or give every agent the same style.
- **Group icons.** Give a group an emoji icon; it shows in the sidebar and
  the chat header.

### Changed

- **Instructions apply live.** Edits to an agent's instructions reach a
  running agent on its next message (bridge 0.8.59 or later); before, they
  only applied after recreating the runtime.
- **One agent profile.** The separate agent detail page duplicated the panel
  on the Agents page; old `/agents/<id>` links now open that panel.
- **Clearer menu:** Work (Dashboard, Messages, Projects, Approvals), Team
  (Agents, People for admins), and Company (Customers, Knowledge base, Files,
  Automations).
- **Customers say what needs attention.** The unexplained "Needs review"
  badge is replaced by a count and a list of the approvals, blocked tasks,
  incidents, and reviews behind it, each linked; the customer also lists its
  projects. Finished tasks no longer count as blocked.

### Upgrade notes

- Migration `0049` adds group icons; it runs on start.
- Update the Hermes plugin on your runtimes for live instructions, memory in
  every turn, and `emperor_remember`.

## [0.8.58] — 2026-10-04

### Added

- **Emperor setup.** First sign-in opens a full-screen setup assistant for
  owners and admins: your company (what it does, kind of company, website,
  house rules), an AI model key, a team suggested for your kind of company,
  and launch. The model key is now required and checked with the provider
  (OpenRouter or DeepSeek) before agents start, since agents can't answer
  without one; OpenRouter starts on a free model.
- **Your lead documents the company.** When the lead agent comes online, it
  gets its first job: turn the profile and website into Knowledge & Rules
  notes (overview, products and services, customers, brand voice) and ask the
  owner what it couldn't find. The assistant shows its progress live, with
  links to its chat and the task.

### Changed

- The old first-agent card on the dashboard is replaced by the assistant.
  **Set up later** closes it; with no agents, the dashboard links to hiring
  one.

## [0.8.57] — 2026-10-04

### Added

- **Send work from your platform.** Another system (a "send to agent" button
  in a CRM, help desk, or portal) can hand a request to one agent with
  `POST /api/mcp/requests`. Emperor creates a task for the agent and posts the
  prompt in its direct chat, shown as coming from the platform ("Acme Portal
  (via API) · on behalf of ana@client.example"), never as a company member.
  Read it back with `GET /api/mcp/requests/{id}` (status, the agent's replies,
  the task's output), or get signed status callbacks. Idempotency keys make
  double clicks safe. Operator MCP connections get `send_agent_request` and
  `get_agent_request`.
- **Requests-only tokens.** A new access level in Settings → Access Tokens
  that can only create and read its own requests; every other endpoint, the
  MCP server, and the realtime socket refuse it. It can carry an encrypted
  callback URL.

### Fixed

- **The daily review and approval decisions reached Hermes agents as already
  handled**, so older bridges skipped them. Work Emperor hands an agent is now
  queued and tracked like a person's message (acting, resolved, failed), with
  no bridge update needed. It also counts in agent health and in agent-down
  alerts.
- The chat showed Emperor's own messages (daily review, approval decisions)
  under the agent's name; they now say Emperor, or the requesting platform.

### Upgrade notes

- Migration `0048` adds the requests table and two token columns; it runs on
  start.

## [0.8.56] — 2026-10-04

### Added

- **Today dashboard.** The dashboard now shows what needs you (approvals
  waiting and how long, unread notifications, your open tasks, agents needing
  attention, open incidents) and a card per agent and person: what they are
  working on right now, what is waiting on a person, what is next (overdue
  flagged), and what they finished today. Filter by agents, people, or your
  own work.
- **Daily review.** Each morning Emperor posts a review in every agent's
  direct chat with its open tasks as live cards and asks it to move each one
  forward, report blockers, and reply with a summary. Agents without open
  tasks get nothing. Set the time, timezone, and weekdays in
  **Settings → Routines**, or send it now. On by default at 09:00 UTC on
  weekdays.
- **Agents request approvals.** New MCP tool `request_approval`, Hermes tool
  `emperor_request_approval`, and `POST /api/mcp/approvals` now accepts just a
  `taskId` (the project is derived). The task waits in review until a person
  decides.
- **Agent down alerts.** An agent that stops checking in for 5 minutes is
  marked offline; if it had open tasks or waiting messages, owners and admins
  get an **Agent down** notification (bell, email, webhook).

### Changed

- **Approvals page.** Each request shows who asked, for what, how long ago, a
  link to the task, and the rationale. Approve, or send back with a required
  note; a recent-decisions list shows what was decided. The decision and note
  are posted to the agent's direct chat.
- **Approvals close correctly.** Approving `task_done` closes the task;
  approving any other action (send an email, spend, publish) returns it to in
  progress so the agent does it; rejecting returns it to in progress instead
  of leaving it in review. Decisions are final, and requests are checked
  against the company's own tasks.
- **Simpler menu**, grouped into Work (Dashboard, Messages, Projects,
  Approvals), Team (Agents, Customers), and Library. Approvals shows a pending
  badge. Budgets moved into Agents, and Ops into Settings.
- **Doctrine: working a request.** Agents are told to open a task for each
  substantial request, keep its state true, request approval before
  spending, sending outside the company, publishing, deleting, or sign-off
  closes, and to work through the daily review. Update the Hermes plugin on
  your runtimes to get the new tool and guide.
- Failed and dead-letter tasks no longer count as open work in health.

### Upgrade notes

- Migration `0047` adds the routine settings to companies; it runs on start.

## [0.8.55] — 2026-10-04

### Added

- **Emperor decides who answers.** `/messages/sync` now gives each runtime a
  verdict per message: `addressedToYou` and a `routeReason` (`targeted`,
  `direct`, `mention`, `all`, `not_addressed`, `targeted_other`, `loop_guard`,
  `self`). The Hermes and Codex bridges follow it, so every runtime routes the
  same way; against an older server they keep their own equivalent rules.
  Mentions match full names before first names, so `@Max Builder` no longer
  also wakes an agent called Max.
- **Server-side loop guard.** After `EMPEROR_AGENT_LOOP_MAX_TURNS` (default 6)
  consecutive agent messages in a team or group thread, agents are no longer
  asked to answer and Emperor posts one visible pause notice; a person writing
  resets it. Runtimes that ignore the verdict are refused (`429`) at three
  times the limit.
- **Notifications.** A bell in the sidebar collects what needs you: an agent
  @mentions you, an agent is waiting on your decision (a `choices` block), an
  approval is requested, a task is assigned to you, an agent couldn't process
  your message, or a high/critical incident opens. Each person chooses which
  kinds also arrive by email (Settings → Notifications), and admins can send
  them to Slack, Discord, or any JSON webhook (URL stored encrypted). Repeats
  collapse to one per thread and kind every 10 minutes.
- **Agent health** at Agents → Health: per agent over 7 days, unanswered and
  failed messages, retries, median reply time, requests and replies, open,
  overdue, and closed tasks, and cost, with a status (Down, Needs attention,
  Healthy, Idle) and a list of the messages that need attention. Agents can
  read it with the new MCP tool `get_agent_health`.

### Fixed

- A runtime giving up on a message after its retries (`executionState:
  "cancelled"`) was silently ignored, so the message stayed "queued" forever
  and nobody was told. It is now marked *Failed after N attempts* in the chat,
  counted in agent health, and the sender is notified. Failed attempts are
  counted as they happen.
- Doctrine no longer tells agents that mentioning a person doesn't notify
  them; it now does.
- Messages: the 15-second background refresh re-applied a deep link
  (`?agent=`), pulling you back to that conversation after you had switched
  to another one.

## [0.8.54] — 2026-10-03

### Added

- Group chats: members-only channels that work like the team channel. Create
  one for a set of agents and people (e.g. a *Development team* with the devs
  and the tester) from **Messages → Groups → +**, with templates, or from any
  runtime. Only member agents receive a group's messages, and they reply when
  @mentioned. Every turn tells the agent the group's name, purpose, and
  members. Anyone in the company can open a group; posting makes you a member
  and turns on its unread badge.
- Group management for agents and runtimes: MCP tools `create_group`,
  `list_groups`, `get_group`, `update_group`, `add_group_members`,
  `remove_group_member`, and `archive_group`; REST under `/api/mcp/groups`;
  Hermes plugin tools `emperor_list_groups`, `emperor_create_group`,
  `emperor_add_group_members`, and `emperor_remove_group_member`. An agent
  that creates a group joins it, and an agent-bound token can only change
  groups its agent belongs to. Only members can post into a group.
- `/messages/sync` now tags every message with `threadType` and `threadTitle`,
  plus group details in `threads`. Older runtimes ignore the new fields.
- `@all` (or `@everyone`) in a group chat addresses every member agent at
  once, and the composer offers it first. Only a human's `@all` counts: an
  agent's is ignored so one agent can't wake the whole group in a loop, and it
  only applies to groups, not the company-wide team channel.
- Doctrine and docs cover group chats and `@all`: the Hermes operating guide,
  skill, and built-in fallback guide, the bridge turn prompt, MCP server
  instructions and `send_message`, the Codex bridge prompt, the Boss template,
  the starter "Agent Operating Rules" note seeded into new companies, the
  README, and the Messaging, Hermes runtime, Operating pipeline, Agent
  operating manual, Overview, Usage, MCP, and API reference docs. Existing
  companies keep their current "Agent Operating Rules" note; add the
  group-chat line to it if you want it in your shared doctrine.

### Fixed

- The Hermes bridge's agent-to-agent loop guard and restart guard never
  engaged, because synced messages carried no thread type. With it now present,
  the loop guard protects team chat and groups. The restart guard is narrowed to
  skip only agent messages from before the restart, so it can no longer freeze
  a thread until a human writes.
- The Codex bridge treats group chats and unknown thread types like team chat
  (reply only when @mentioned) instead of answering every message.
- `/api/chat/status` could create a read-cursor row for a thread id from
  another company; it now only touches the caller's company's threads.

## [0.8.53] — 2026-09-27

### Fixed

- Long Hermes jobs are no longer killed by a ten-minute wall-clock limit. The
  bridge now allows active work to continue and stops only after 15 minutes
  without observable output, agent-log activity, or session-store activity.
- Hermes stdout and stderr are drained continuously, preventing large tool
  results from filling an OS pipe and freezing an otherwise healthy turn.

## [0.8.52] — 2026-09-27

### Fixed

- Hermes timeout/failure logs no longer serialize the full subprocess command,
  model prompt, doctrine, or chat context. Errors are redacted and capped.

## [0.8.51] — 2026-09-27

### Added

- Hermes now exposes the same exact, bounded task overview available through
  MCP and `GET /tasks/overview`, plus bounded multi-file upload and artifact
  replacement tools with explicit per-file outcomes.

### Fixed

- Direct prompts stranded in `queued`, `seen`, or `acting` now recover after a
  bridge restart or a human Retry. Stopping the service also terminates the
  complete Hermes process group instead of leaving an invisible child alive.
- One failed turn can no longer monopolize an agent indefinitely: turns have a
  ten-minute default ceiling and become visibly cancelled/retryable after three
  failed attempts.
- Bridge-originated turns inject the Emperor operating guide only once, and
  task overviews now calculate full-set totals, genuine unfinished dependency
  blockers, and actual pending approvals.
- File uploads use atomic local writes, reject active-path collisions, and the
  metadata route can no longer create an internal Storage record without bytes.

## [0.8.50] — 2026-09-27

### Added

- `get_task_overview` provides a bounded server-side task summary for agent
  status questions: totals by state plus priority, dependency-blocked, and
  approval-required work. Full task detail remains on demand.

### Fixed

- Hermes bridge defaults now bound shared knowledge, team-chat history, and
  rich-reply guidance so a status question cannot monopolize an agent queue.

## [0.8.49] — 2026-09-27

### Fixed

- Direct-message queue controls now preserve cancelled messages as dismissible
  history, and the queue is shown only when two or more messages are pending.
- Agent task overviews are paginated instead of loading an unbounded task list
  into a Hermes turn.
- Production update tooling serializes updates, checks available memory before
  a build, and never performs an implicit Docker build during deployment.

## [0.8.48] — 2026-09-27

### Added

- Live record cards in chat. An agent can link a task, project, or agent as
  `[label](emperor://task/<id>)` and the chat shows its current state: a
  status chip inside a sentence, or a card on a line of its own (assignee, due
  date, project progress, agent load). Cards refresh every 30 seconds and on
  tab focus, batched into one request, and follow the app's visibility rules.
  Clicking opens the record; `/projects?project=…&task=…` now deep-links to a
  task on the board.
- ```` ```choices ```` quick-reply buttons for decisions. A click sends the
  option's prompt as the operator's reply, and the block locks on the chosen
  answer, including after a reload.
- The Hermes bridge includes teammates' ids in the roster when rich replies
  are on, so agents can link each other without a tool call, and summarizes
  choices blocks in history context.

## [0.8.47] — 2026-09-27

### Fixed

- Hermes bridges now preserve failed turns in a durable retry ledger with
  bounded exponential backoff, instead of marking them seen and losing them.
  Direct messages stranded in `acting` by a stopped bridge are recovered on
  the next start.
- MCP fleet rate limiting now supports normal multi-agent bridge polling while
  retaining bounded authentication throttling.
- Storage integrity can be checked through `GET /artifacts/{id}/verify` and
  the Hermes `emperor_verify_artifact` tool. It verifies blob presence, size,
  and SHA-256 without exposing file bytes to the model.
- Storage guidance now clearly distinguishes metadata creation from file
  uploads, documents replacement, and explains multi-file folder uploads.

## [0.8.46] — 2026-09-26

### Fixed

- Agent tables no longer collapse into a wall of pipes. Models often emit a
  table whose separator row has a different column count than the header, or
  put the whole table on one line; the chat now repairs both before rendering.
- A Hermes bridge updated before its Emperor server now picks up rich replies
  without a restart: it re-checks the server's capabilities every 10 minutes
  (`EMPEROR_CLAW_CAPABILITY_REFRESH_SECONDS`) and logs when they change.
- The reply guide steers metrics toward stats tiles and charts, spells out
  table rules, and tells agents never to post chart images or local file
  links. Images the browser can't load show a labelled placeholder instead of
  a broken icon.

## [0.8.45] — 2026-09-26

### Added

- Rich agent replies. Agents can now answer with KPI tiles (```` ```stats ````),
  native charts (```` ```chart ````: bar, stacked, horizontal, line, area, pie,
  donut), tabbed panels (```` ````tabs ````), GitHub-style callouts
  (`> [!TIP]`), and interactive HTML widgets (```` ```html ````). They render in
  direct and team chat and follow light and dark mode. Widgets run in a
  sandboxed iframe with no network access, and can send a follow-up prompt only
  right after the operator clicks inside them. Tables get sticky headers and
  zebra rows. See the new *Rich Replies* docs page.
- A capability handshake teaches agents the new formats: `/runtime/register`
  now returns `serverCapabilities` and a `replyFormatGuide`, which the Hermes
  and Codex bridges add to each turn. Older servers never advertise it, so
  agents talking to them keep writing plain Markdown. Rich blocks are ordinary
  fenced code, so older UIs show them as code. Set
  `EMPEROR_CLAW_RICH_REPLIES=off` to opt an agent out.

### Fixed

- Hermes agents were told by Hermes' CLI platform hint that "Markdown does not
  render" and to write plain text. The container now replaces that hint, and
  the bridge corrects it every turn, so replies use Markdown properly.
- Team-chat history fed into a DM turn replaces rich blocks with short labels
  (`[chart: Tasks closed]`) instead of spending the context budget on markup.

- Request the published amd64 images explicitly when hiring or updating on ARM
  Docker hosts with emulation, rather than failing to find an ARM manifest.
- Explain Hermes progressive tool discovery and prevent confusing Emperor LLM
  tool names with shell commands.

## [0.8.44] — 2026-09-23

### Fixed

- Agents no longer post their reply twice. An agent could answer the message it
  was replying to and also call `emperor_send_message`, which posted a second,
  meta message ("Replied in the direct thread, message id …") into the same
  thread. The guidance is now explicit in the tool description, the plugin's
  context hook, the bridge's turn prompt, and the baseline operating guide: the
  runtime delivers the agent's answer, and `emperor_send_message` is only for a
  different thread.

## [0.8.43] — 2026-09-23

### Fixed

- An agent's reasoning and live activity are visible again. The bridge reads the
  agent's thinking from `$HERMES_HOME/state.db` and its tool activity from
  `$HERMES_HOME/logs/agent.log`, but local provisioning never set `HERMES_HOME`,
  so both resolved to none and every turn showed only a bare elapsed-time
  status. The runtime now points `HERMES_HOME` at the agent's own profile,
  matching the documented layout.

## [0.8.42] — 2026-09-23

### Fixed

- Agents no longer spin in a tool-call loop. Hermes' tool-loop guardrail is
  warning-only on CLI sessions, which is how the bridge runs it, so an agent
  that kept calling a tool that kept failing (a task body the API rejected, a
  bad argument) looped until the iteration cap instead of replying. The runtime
  now enables the guardrail hard stop, so the turn ends with a short
  explanation. Legitimate iteration is unaffected — a successful mutating call
  resets the failure streak.

## [0.8.41] — 2026-09-23

### Changed

- Long agent turns are no longer cut off. The per-turn timeout now defaults to
  0 (no ceiling), so an agent can work for hours on a single turn — a coding
  session, a large documentation pass. The operator can still stop a running
  turn from the UI, and the runtime control is polled during the turn. Set
  `EMPEROR_CLAW_HERMES_TIMEOUT_SECONDS` to a positive number of seconds to
  reinstate a hard ceiling for a genuinely hung turn.

## [0.8.40] — 2026-09-23

### Fixed

- Local agents no longer abandon long turns: the per-turn timeout is now 30
  minutes by default (was 5), in both the bridge and local provisioning. A
  tool-heavy turn that writes documentation or drives a browser no longer gets
  killed at the 5-minute mark.
- A failed turn no longer posts a generic "I hit an error and couldn't reply"
  line into the conversation. The failure is still logged for the operator; the
  line read as the agent answering with an error, and was misleading for the
  recoverable cases (a timed-out turn resumes from its checkpoint).
- Onboarding can be re-run: the tour no longer hides behind a stale
  localStorage flag. The server onboarding state is the single source of truth.
- A fresh self-hosted install sends the operator to signup instead of a
  dead-end login form they cannot satisfy.

## [0.8.39] — 2026-09-22

### Fixed

- Agent replies no longer leak tool activity. The bridge now runs Hermes with
  `--format stream-json` and takes only the model's final answer, so tool
  previews (the TUI's `review diff` blocks, command output) can no longer be
  mistaken for the reply. Session id comes from the structured event too, with
  the plain-text path kept as a fallback.
- A missing or unreadable `operating-guide.md` no longer crashes every turn and
  silences the agent. The bridge degrades to a condensed built-in guide and logs
  one warning per process. Set `EMPEROR_CLAW_OPERATING_GUIDE_PATH` to point at
  the real guide when a deployment does not mirror the repo's directory tree.

## [0.8.38] — 2026-09-21

### Added

- A Boss (Team Lead) role template, pinned above the specialist grid, that
  coordinates the roster, assigns each task to one owner, and verifies closure.
- Guided company onboarding: name, what you do, industry, and website are
  captured into company context, and a starter Knowledge & Rules scaffold is
  seeded (Company, Agents, Projects, Customers folders).
- After hiring an agent, the app confirms creation and opens its private direct
  chat as soon as the runtime is online, from both onboarding and the agent
  directory.

### Fixed

- Recreated Hermes containers keep working: a retry, image update, or key
  rotation left the per-profile wrapper missing, so every turn failed with
  "No such file or directory: /home/hermes/.local/bin/<profile>". The entrypoint
  now recreates the wrapper when the profile already exists on the volume.
- The first Hermes hire no longer fails mid-download: the ~3 GB runtime image
  pull gets a 30-minute budget instead of 5.
- Failed provisioning no longer advances the wizard to a permanently
  "disconnected" agent; it reports the failure and offers a retry.
- Hermes' tirith security notice no longer leaks into an agent's first reply.
- The agent detail page shows a "starting up" state during the first-boot window
  instead of the red "never connected" warning.
- Container publishing uses the built-in `GITHUB_TOKEN`; the missing/expired
  `GHCR_PAT` made both image workflows fail with `denied: denied`.

### Changed

- Role doctrine (SOUL/AGENTS/IDENTITY) is delivered to the Hermes runtime, and
  the default doctrine now states the assignment rules: one owner per task, a
  chat mention is not an assignment, and the assignee closes it.
- MCP task tools accept a hybrid assignee (agent or human), matching the
  documented API.
- `EMPEROR_CLAW_HERMES_IMAGE` can override the Hermes runtime image.

## [0.8.37] — 2026-09-21

### Added

- Easy Setup hires with OpenRouter or DeepSeek only. OpenRouter defaults to the
  free `nvidia/nemotron-3-ultra-550b-a55b:free` model, seeded at zero cost so
  reported usage stays $0 and budget-capped workers remain executable.

### Fixed

- The Custom role card is always visible and clickable in the role picker; it was
  clipped below the fold inside nested scroll areas.
- Buttons show a pointer cursor again after Tailwind v4 dropped the preflight rule.
- Deleting a local Hermes agent also removes its Docker volume, and reports a
  warning instead of silently leaving a running container or orphan volume when
  teardown fails.

## [0.8.36] — 2026-09-18

### Fixed

- Hide first-agent onboarding for companies with existing agents, including
  installations with remote Hermes workers that do not need local Docker setup.
- Keep a new worker's onboarding open across the hiring dialog's dashboard refresh.
- Explain that private chat needs no @mention, while team chat requires addressing
  the agent. Unlock setup completion only after the worker returns `ACK working`.

## [0.8.35] — 2026-09-18

### Fixed

- Fresh Hermes profile volumes are writable by the runtime user, and first
  container creation allows time for Docker to unpack the runtime image.
- Preserve registry authorization errors in local Hermes setup and reject Docker
  streamed pull failures even when the HTTP response is 200.
- Failed local workers show a single retry action instead of manual CLI setup.
  Recreating a runtime waits for a real heartbeat before reporting online.
- Verify anonymous access to published Hermes images, which fresh installations
  must be able to download without GitHub credentials.

## [0.8.34] — 2026-09-17

### Added

- Hiring starts with local Hermes, then provider/key and one Create & start action.
  Remote setup is an explicit secondary option; Docker errors no longer silently
  switch the hiring flow. Saved connections and custom model names are optional.
- Direct chat controls and `/kill`, `/queue <prompt>`, `/replace <prompt>`
  commands for Hermes. Stop clears pending direct prompts; replacement starts
  a fresh session. Runtime confirmation distinguishes a request from a completed stop.
- Durable control polling during a turn, process-group termination, and rejection
  of late replies from cancelled work. Queued follow-ups survive newer replies
  and a bridge restart.

## [0.8.33] — 2026-09-17

### Beginner setup

- Replace manual OpenClaw onboarding with local Hermes creation, a runtime
  heartbeat check, private test chat, and first-project/task guidance.
- Install Docker through the official Ubuntu/Debian repository, Homebrew on Mac,
  or winget on Windows when available; otherwise provide the platform guide.
- Server installers need no Git or Node.js, work when piped into a shell,
  preserve secrets, repair blank setup values, and verify startup and app-user
  Docker access before reporting ready. Public installer URLs now install the
  server; legacy bridge installers have explicit names.
- Optional domain setup enables Caddy with automatic HTTPS, preserves enabled
  Compose profiles, and checks public reachability. Default app access binds to
  loopback; app/database/proxy services restart after Docker starts.
- Update Compose/Caddy configuration for installations without a Git checkout.
  Self-hosted instance admins can access update controls without an email
  allowlist; configured restrictions and cloud behavior are preserved.
- Align README, installation, and first-worker guides with the Docker path and
  clearly describe Docker prerequisites, API keys, and recovery.

### Added

- Load a practical Hermes operating baseline in bridge prompts and plugin hooks
  even when the company KB is empty. Expand the skill with scenarios for group
  chat, human decisions, delegation, projects, scoped knowledge, and Storage.
- Knowledge MCP tools accept explicit publication status, and context lookup
  accepts reference IDs and tags.

### Fixed

- Respect auto-injection being disabled: unshared notes enter context only on
  explicit selection, tag lookup, or as a linked reference to selected notes.
- Suggest distinct mention aliases for workers with the same first name.
- Clarify that human @mentions are text, not guaranteed notifications, and that
  project goals are displayed names and should stay short.

## [0.8.32] — 2026-09-17

### Added

- Agents now surface their **real** model reasoning in the chat activity line.
  The bridge reads it from the runtime's own session store instead of guessing,
  through a pluggable `ReasoningSource` interface
  (`EMPEROR_CLAW_REASONING_SOURCE`: `auto` | `session-store` | `none`) so any
  runtime can supply its own. When a runtime exposes no reasoning, nothing is
  claimed — `none` is a fully supported path, not a degraded one.
- Team chat shows the activity line too; it previously received the detail and
  rendered a bare "is typing".
- Optional persisted reasoning history (`EMPEROR_CLAW_REASONING_HISTORY=on`,
  **off by default**), exposed as a collapsed "Show reasoning" disclosure on an
  agent's message. Stored in its own table and fetched only on expand, so the
  polling message list never carries transcripts. Reasoning is raw model output
  and can quote the user verbatim or contain paths and credentials, so enabling
  it is a deliberate choice by the runtime operator.

### Fixed

- The bridge no longer fabricates a "thinking" state. It used to infer one from
  a gap in tool-executor log lines and emit a literal `thinking` string, having
  read no reasoning at all.
- The activity line is no longer uppercased when it carries real reasoning;
  uppercasing a sentence of model prose shouted it. The uppercase treatment
  remains on the bare "is typing" label.
- The direct-chat typing bubble is bounded to the message-bubble width. It was
  shrink-to-fit, so a full sentence stretched it past the column instead of
  letting the text truncate.
- A reasoning source is no longer permanently disabled by a negative result at
  startup. On a fresh install the session store does not exist yet, and latching
  that first "no" left reasoning silently dead until someone restarted a bridge
  that runs for weeks.
- Reasoning rows are filtered for substantive content rather than merely
  non-null. Assistant rows carry a stub for most steps of a turn, so taking the
  newest row unconditionally reported nothing while a real thought sat one row
  behind.


## [0.8.31] — 2026-09-17

### Added

- Create local Hermes workers with one click after selecting a role and an
  existing worker's stored LLM configuration. Each worker gets its own container,
  persistent volume, and agent-bound token, and inherits the source access scope.
- Hermes workers can hire additional workers using `emperor_create_agent`.
  MCP and REST creation also support local provisioning; agent-bound tokens use
  their own worker as the configuration source without exposing credentials.
- Preserve role template doctrine during easy setup and cover native hiring and
  Hermes-only local provider selection with regression tests.

### Changed

- Hermes is the only supported local runtime. Remove Codex and generic local
  setup paths and reject other local providers in creation and update APIs.
- Docker startup no longer marks a worker online before its runtime heartbeat.

### Fixed

- Stop bare-metal setup when Hermes profile creation fails.
- Return an existing worker ID after provisioning failures so callers can retry
  setup without creating duplicate profiles.

## [0.8.30] — 2026-09-16

### Security

- `/api/ui/artifacts/[id]` now enforces the download route's visibility rule, so
  private human uploads no longer leak their content to other users.
- `/api/mcp/actions` and `/api/mcp/threads` reject project/task ids from another
  tenant instead of persisting them.
- Invited and registered users get `instance_role = member` (the only non-admin
  instance role) instead of a company role outside the declared union.

### Fixed

- `ensureDirectThread` serializes creation per (company, agent) with an advisory
  lock, so concurrent callers can no longer create duplicate direct threads and
  split a DM history; `ensureTeamThread` adopts the winner on a unique-violation
  race instead of returning 500.
- The watchdog re-checks state and lease in its UPDATEs, so a task finalized
  mid-scan is no longer resurrected into the inbox.
- Company resolution orders memberships deterministically when a user belongs to
  more than one company.

### Performance

- Index `thread_messages` for the MCP message-sync long-poll (adds migration
  `0042`).

## [0.8.29] — 2026-09-16

### Security

- Enforce token→agent binding on the agent-acting MCP routes (`messages/send`,
  `report-usage`, agent memory, `chat/status`, `actions`). A token bound to an
  agent can no longer send, report usage, write memory, or set status as a
  sibling agent. Company-wide tokens are unaffected.
- Derive the client IP for rate limiting from the socket, honouring
  `X-Forwarded-For` only when the peer is listed in `TRUSTED_PROXY_IPS`. A
  forged header can no longer bypass the pre-auth MCP throttle.

## [0.8.28] — 2026-09-16

### Security

- Bind company tokens to a single agent. A leaked runtime token can no longer
  act as a sibling agent or lease its decrypted integration secrets by passing
  its name; operator and OAuth tokens stay company-wide. Adds migration `0041`
  (`company_tokens.agent_id`).
- Restrict company `contextNotes` writes to admins, and delimit the notes block
  in the MCP instructions as untrusted data, closing a prompt-injection path
  into agents that run with terminal/web tools.
- Verify a webhook-supplied `thread_id` belongs to the caller's company.
- Reject MCP callers posting as a human sender, so an agent cannot forge a human
  message or its audit trail.
- Stop serving `image/svg+xml` inline, so a scripted SVG cannot execute on the
  app origin.

## [0.8.27] — 2026-09-16

### Fixed

- Split the report-usage integration test into capped and uncapped cases so the
  0.8.26 behavior — record usage for agents without a budget instead of
  returning 422 and wedging them — is verified rather than tripping the previous
  unconditional-rejection expectation.

## [0.8.26] — 2026-09-16

### Security

- Gate company-token minting, listing, and revocation behind the admin role, and
  reserve `mcp_danger` tokens for owners. Any member could previously mint a
  privileged token and lease decrypted integration and resource secrets.
- Require an admin role for OAuth consent, and restrict instance-role changes to
  instance admins so a company owner can no longer promote anyone — including
  themselves — to `instance_admin`.
- Scope member access-scope reads and writes to the caller's company, and
  authorize them from the database role instead of the cached JWT claim.
- Require an admin role for local agent setup and strip shell metacharacters
  from the agent role, closing a command-injection path on bare-metal installs.
- Require a human session (not an MCP token) to resolve approvals, so an agent
  can no longer approve its own gate.
- Redact encrypted provider keys from MCP agent-memory responses, verify agent
  ownership before writing memory, and require the privileged token scope to
  list company members.

### Fixed

- Persist Hermes bridge state atomically and preserve corrupt files, so a crash
  can no longer wipe sessions, thread ownership, and the loop/cold-start guards.
- Record usage for agents without a budget instead of returning 422, which
  previously wedged an unpriced agent permanently after its first turn.
- Record the chat-send dedup key only after a successful send, so a failed send
  no longer makes the retry look like a duplicate and silently drop it.
- Clamp the knowledge-context `maxChars` so a caller cannot pull the entire
  vault into a single prompt.
- Keep the floating-chat draft when a send fails, announce project errors to
  assistive tech, and load invitations in an effect instead of during render.

### Changed

- CI now runs the Hermes bridge tests, builds the Docker image, and fails on
  migration/schema drift. The compose Postgres port binds to loopback and its
  password is overridable.

## [0.8.25] — 2026-09-13

### Fixed

- Add the missing authenticated runtime budget endpoint. Recompute thresholds
  from recorded spend and reset paused agents when the UTC month changes.
- Block Codex and Hermes dispatch on exhausted budgets, missing capped-model
  pricing, or unavailable budget checks. Leave blocked messages queued.
- Await usage reporting each turn and retry unacknowledged samples before
  dispatching more work; remove Hermes's 60-second reporting delay.
- Serialize usage increments, monthly rollover and status updates in one
  transaction. Avoid duplicating historical spend in monthly summary rows.
- Reject unknown usage pricing instead of recording free usage, and price a
  reported runtime model without overwriting the configured model.
- Update the Drive documentation test to follow the dedicated setup guide
  after the README rewrite.

### Notes

- Budgets still use estimated token counts. In-flight turns can overshoot;
  this release does not provide an exact provider billing cap. Upgrade the
  server and restart updated bridges together.

## [0.8.24] — 2026-08-24

### Added

- **Chat now shows which of your messages are still queued vs. actually
  answered.** Each pending message gets its own status: "Queued" or
  "Being handled" (pulsing), instead of a single group-level Read/Sent
  receipt that said nothing about a backlog.

### Fixed

- **A queued message could show as "resolved" before the agent had
  actually processed it.** `updateThreadExecutionState()`'s "resolved"
  transition applied to every unresolved message in a thread at once —
  so when message 1 of a 3-message backlog got its reply, messages 2
  and 3 flipped to "resolved" in the same instant, even though the
  agent hadn't started them yet. "resolved" is now scoped to the exact
  message that got a reply; "seen"/"acting" stay thread-wide on purpose
  (the agent genuinely is looking at/working the whole thread, not just
  one message, so batching those two was already correct).

## [0.8.23] — 2026-08-23

### Added

- **The Hermes typing indicator now shows what's actually happening,
  not just "typing…".** Checked NousResearch's Hermes Agent CLI (latest
  v0.20.5) for a way to stream real tool-call-level progress — there is
  no `--json`/event-stream flag on `hermes chat`, and `hermes webhook` is
  for inbound triggering, not turn progress. Rather than parse Hermes's
  human-readable stdout (free to change on any release, and would
  silently break turn handling if it did), the bridge now surfaces
  telemetry it already owns: elapsed turn time and whether it's
  continuing a resumed session — e.g. "Viktor: working (42s)" instead of
  a bare typing dot. New `threadParticipants.currentActivity` column,
  threaded through `/chat/status`'s existing `activity` param and
  cleared the instant typing stops so nothing goes stale.

## [0.8.22] — 2026-08-23

### Added

- **Per-agent data scoping.** Agents can now be restricted to specific
  customers/projects — a `Scope` tab on the agent detail page lets you set
  an agent to "Restricted" and pick which customers and projects it may
  read or act on. Restricted, it gets filtered lists and 404s on
  out-of-scope customers, projects, tasks, artifacts, and Knowledge &
  Rules, and 403s on writes/claims targeting anything outside its grant —
  enforced server-side in the MCP routes themselves, not just the prompt
  layer, since an agent can always fall back to a raw HTTP request. Team
  chat and the agent roster stay company-wide by design. Existing agents
  are fully unaffected by default (unrestricted unless explicitly scoped).

### Fixed

- **`emperor_hermes_bridge.py`: a message could get redispatched as a
  duplicate reply if Emperor Claw was briefly unreachable during its own
  bookkeeping calls** (e.g. mid-deploy). The per-message error-recovery
  path called `update_chat_status()`/`send_heartbeat()` unwrapped; if
  either failed at that exact moment, the failure escaped before the
  message was marked locally "seen," so the next poll cycle redispatched
  it as a brand-new Hermes turn — occasionally after a first attempt had
  already sent a real reply. Each recovery call is now isolated in its
  own try/except, so a message is always marked seen exactly once
  regardless of what else fails around it.

## [0.8.21] — 2026-08-22

### Fixed

- **Sending a second message before the agent finished with the first made
  it vanish.** `updateThreadExecutionState()` always resolved only the
  single *latest* human message in a thread. If you sent another message
  while the agent was still working the first one, that new message became
  "latest" — so when the agent reported it was done, the code marked the
  unread message as resolved instead of the one it actually answered,
  orphaning the original and making the new one look already-handled. It
  now advances every unresolved human message together, so a backlog sent
  while the agent is busy is no longer silently dropped.
- **Voice messages were unreadable by the agent, and showed a raw file path
  in chat.** Voice uploads were never registered as artifacts — just
  written to storage with a URL stuffed into the message text as
  `[audio:...]`. That broke two ways: the URL was relative, but the chat
  renderer's regex only matched `https://` links, so the literal tag
  printed as text; and with no artifact row, neither the UI download route
  nor the agent's own artifact tools could resolve the file (404/401),
  so agents had no way to fetch or transcribe it. Voice notes now go
  through the same artifact-registration path as file attachments, so
  they show up in the agent's artifact list, download correctly, and
  render as an inline player in chat.

## [0.8.20] — 2026-08-20

### Fixed

- **Old messages could randomly "reappear" in an agent's direct chat.**
  `ensureDirectThread()` looked up an agent's canonical thread with an
  unordered query — when a race created two direct threads for the same
  (company, agent) pair, which one resolved as "the" conversation was
  arbitrary per request, so the app could flip between two different
  message histories and surface an old message as if it had just arrived.
  The lookup now orders by `createdAt` so it always converges on the same
  (oldest) thread.
- Consolidated the 11 duplicate direct threads this had already produced
  across 8 agents in production: messages were moved into each agent's
  oldest thread (original timestamps preserved) and the duplicates
  archived — no data lost, verified by message-count before/after.

## [0.8.19] — 2026-08-19

### Fixed

- **Team Channel unread messages had no visual indicator.** The sidebar's
  "Messages" badge counts unread agent messages across every thread,
  including the Team Channel, but the Messages page only ever rendered
  unread badges on direct agent threads — the Team Channel button itself
  never showed one. Unread team messages bumped the sidebar count with
  no way to tell where they were. The Team Channel now shows its own
  unread badge (desktop sidebar and mobile conversation switcher), using
  the same per-participant `lastReadAt` logic direct threads already use.

## [0.8.18] — 2026-08-19

### Fixed

- **Docker Publish (Hermes) build was still broken after v0.8.17**: with
  Node.js now installed, the Hermes Agent installer's `npm install` failed
  compiling `node-pty` (a native addon with no prebuilt binary for this
  platform) because the image had no C/C++ build toolchain. Added
  `build-essential` to `integrations/hermes/Dockerfile` so `node-gyp` can
  compile it. Verified locally end-to-end: the installer now reports
  "Installation Complete!".

## [0.8.17] — 2026-08-19

### Fixed

- **Docker Publish (Hermes) build was broken** for every release since v0.8.14:
  the `integrations/hermes/Dockerfile` build crashed (exit 127) while the
  Hermes Agent installer tried to auto-download and extract its own bundled
  Node.js runtime. The Dockerfile now installs Node.js 26 via NodeSource
  before running the installer, so its `command -v node` check finds a
  working Node/npm already on `PATH` and skips that broken fallback path
  entirely.

## [0.8.16] — 2026-08-16

### Fixed

- **Hermes agents no longer re-run slow turns forever after a timeout.** When a
  turn exceeds the bridge's per-turn timeout (typical for browser-heavy work
  like checking several AI engines), the Hermes subprocess was hard-killed
  mid-flight — the work was lost, and because the agent's bridge state lived
  inside the container, a recreate re-offered the same message and restarted
  the same slow turn from scratch, repeating it without ever completing.
- The agent's Hermes profile, sessions, and bridge state now live on a **named
  Docker volume** (`~/.hermes/profiles`), so container recreates
  (recreate-runtime, image updates) resume the same Hermes session and keep
  the bridge's `seen`/`lastSeenAt`/`sessions` state. The entrypoint writes the
  MCP token idempotently so a persisted profile can't carry a stale token.
  Degrades to the old ephemeral behavior with a warning if the volume can't be
  created.
- **Graceful turn timeout**: Hermes now runs in its own process group; on
  timeout the bridge SIGTERMs the whole tree (including browser tool children),
  waits a configurable grace window (default 10s,
  `EMPEROR_CLAW_HERMES_TIMEOUT_GRACE_SECONDS`) for Hermes to checkpoint/save
  its session, then SIGKILLs. If the killed turn already emitted its session
  id, the next dispatch resumes it via `--resume` instead of starting over.

> [!NOTE]
> Existing Hermes agents pick this up when their runtime container is
> recreated (Settings → agent → recreate runtime). For browser-heavy agents,
> consider raising `EMPEROR_CLAW_HERMES_TIMEOUT_SECONDS` (default 300s) so
> legitimate long research turns aren't killed.

## [0.8.15] — 2026-08-16

### Added

- **Agents now know who is speaking.** Human message metadata carries
  `senderName`, `senderEmail`, and `senderRole`, resolved at write time from
  the company member and persisted on every thread message (no migration —
  lives in `metadataJson`). The agent bridge injects it into the prompt
  (`[From Alice <alice@x.com>]`), so when two users share the same agent's
  direct thread the agent can tell them apart. The chat UI also labels other
  members by name instead of showing "You" for every human message. External
  platform senders (webhook `from_user_id`) fall back to a generic label.
- **Attach files to agent and team chat messages.** A paperclip button uploads
  files (up to 25 MB, MIME allowlist) into Storage as company artifacts;
  messages carry compact attachment refs and the UI renders attachment chips
  on pending and received messages with a download link. The agent bridge
  lists the attachments in the prompt and tells the agent to fetch the bytes
  itself via the existing MCP endpoint `GET /api/mcp/artifacts/{id}/download`
  — the bridge never downloads or writes files. Attaching a file is treated as
  explicit consent to share it with the company's agents (`visibility:
  "company"`).

> [!NOTE]
> Fully backward compatible: old agent bridges ignore the new metadata fields
> (they only read message text), and new bridges degrade gracefully against
> servers that predate these fields. No schema migration required.

## [0.8.14] — 2026-08-06

### Fixed

- OAuth discovery (`.well-known/oauth-authorization-server`) advertised `http://localhost:3000` instead of your instance's real public URL on reverse-proxied self-hosted installs — breaking claude.ai connector registration entirely with an opaque "couldn't register" error, even though the underlying endpoints worked fine. Discovery now derives its origin from the actual request instead of trusting a possibly-stale `APP_URL`.

## [0.8.13] — 2026-08-06

### Added

- **Connect Claude, Codex, and other AI clients directly to your company's brain.** EmperorClaw's MCP server now supports a real OAuth 2.1 + PKCE flow (RFC 7591/8414/9728) — add a custom connector in claude.ai's web UI and paste just your instance URL. No manual Client ID/Secret, no separate token: EmperorClaw registers the client automatically and you approve the connection while logged in. Claude Desktop, Codex CLI, and anything else can still connect with a manual Bearer token from Settings → Tokens, unchanged.
- Once connected, an AI client can pull real data and take real actions against your account — the same 19 agent/task/project/Knowledge & Rules/messaging tools introduced in 0.8.12, plus your company's operating doctrine — instead of you having to paste context into every conversation by hand.

> [!IMPORTANT]
> The OAuth connector path requires your instance to be served over **HTTPS** (a reverse proxy with a real certificate — Caddy, nginx, Cloudflare Tunnel). Self-hosted installs on plain HTTP should use the manual Bearer token method instead — it works everywhere. The `/authorize` screen shows a warning if it detects this.

## [0.8.12] — 2026-08-05

### Added

- **A real, spec-compliant MCP server at `/mcp`.** External clients like
  Claude Desktop or Codex can now connect and discover 19 typed tools
  across agents, tasks, projects, Knowledge & Rules, and messaging — with
  a per-company `instructions` field carrying operating doctrine and
  business rules automatically, instead of seeing nothing usable.
- Every Hermes agent now also connects to this same MCP server
  automatically, alongside its existing tools — no behavior change, just
  a second, richer toolset available on top of what was already there.

### Fixed

- Agent reads (REST and the new MCP tools) no longer return the encrypted
  LLM API key ciphertext/IV/tag — it was being included in agent list/get
  responses with no legitimate reader for it.

## [0.8.11] — 2026-08-05

### Added

- **One-click local Hermes agents.** Hiring an agent now offers a "Local —
  this machine" option that provisions an isolated Hermes Docker container
  automatically — no CLI, no manual profile setup. "Remote — another
  machine" (or manual/OpenClaw) remains available for agents you run
  yourself, unchanged.
- The agent detail panel now shows the Docker container name for
  locally-provisioned agents with a one-click copy button, and the docs
  explain how to `docker exec`/`docker logs` into it directly.

### Fixed

- Self-hosted installs reached over plain HTTP (e.g. a NAS on a LAN with no
  reverse-proxy TLS in front) rendered every page as unstyled bare HTML.
  The CSP's `upgrade-insecure-requests` directive was silently force-
  upgrading every CSS/JS asset request to `https://`, which fails outright
  with no TLS listener present. Removed — it offered no real protection for
  this app's same-origin asset architecture.

## [0.8.10] — 2026-08-03

### Changed

- New direct and team chat messages now merge into the live conversation
  without repeatedly replacing the message list or forcing readers back to the
  bottom while they are reviewing older messages.
- Conversations smoothly follow incoming messages when already near the latest
  message and show a new-message control when the reader has scrolled away.
- Message composers support multiline drafts: Enter sends, while Shift+Enter
  inserts a new line. Mention selection and composed-language input remain
  keyboard-safe.

## [0.8.0] — 2026-07-31

### Added

- **Storage now has a real filesystem hierarchy.** Artifact folders are
  reflected beneath the existing storage root instead of existing only in the
  database, while stable artifact metadata remains in PostgreSQL. The additive
  `0035_storage-mirrors` migration and reconciliation tooling preserve existing
  installations and safely move legacy flat objects into their logical paths.
- **Optional Google Drive mirroring for self-hosted installations.** A pinned
  `rclone` sidecar can synchronize the same Docker storage volume at short
  intervals, with documented OAuth setup, health state, conflict behavior, and
  no effect on installations that leave the feature disabled. Files added
  directly through Drive appear as untracked candidates and can be explicitly
  imported into EmperorClaw metadata.
- **Native document and spreadsheet editing.** Users can create, open, edit,
  and save DOCX and XLSX files without leaving Storage. CSV, text, and Markdown
  editing remain lightweight, while the MIT-licensed Extend editors are
  pinned, lazy-loaded, and attributed in `THIRD_PARTY_NOTICES.md`.
- **Storage creation and organization actions.** New-file creation and rename
  are available from the explorer and right-click menus, including empty DOCX,
  XLSX, CSV, Markdown, JSON, and text files.

### Changed

- **Messages is now a responsive chat workspace.** Phones use a full-height
  inbox-to-conversation flow instead of stacking both panes. Desktop users can
  collapse the inbox into focus mode, switch agents from the chat header, and
  retain both their active conversation and focus preference across visits.
- The mobile application rail is narrower, chat composers use accessible touch
  targets, and the duplicate floating team-chat launcher no longer covers the
  Messages composer.
- Self-hosting and upgrade documentation now explains release configuration
  updates, automatic migrations, storage reconciliation, rollback behavior,
  Drive setup, and native editor requirements. The shell and PowerShell update
  scripts fetch the versioned Compose configuration before restarting.

### Compatibility

- Existing installations require no destructive migration. Database changes
  are additive, existing artifact IDs and APIs remain valid, and local storage
  reconciliation is idempotent.
- Google Drive remains fully opt-in. Without its Compose profile and OAuth
  configuration, storage behavior is unchanged.
- Office editors are loaded only when an editable Office file is opened, so
  installations that do not use them do not pay their runtime cost.

## [0.7.1] — 2026-07-28

### Changed

- **Agent model configuration is now shared everywhere.** Agent creation,
  Agent Details, and Budget & Usage edit the same provider/model pair through
  one searchable selector. Model choices save atomically, remain editable
  before an agent first connects, and configured disabled models stay visible
  without being selectable for new work.
- **Knowledge & Rules folder creation now understands context.** Opening
  *New folder* from inside a folder shows the selected parent as a read-only
  location and asks only for the child folder name.
- Agent and pricing mutations now report save failures instead of silently
  leaving the interface out of sync.

### Fixed

- **Existing Kanban tasks no longer disappear after upgrading to unified human
  and AI assignment.** The old browser default `All Agents` was incorrectly
  migrated to the impossible assignee `agent:All Agents`, filtering out every
  task. Legacy, stale, and invalid saved filters now safely fall back to
  *All assignees*, and a visible *Clear filters* action provides an immediate
  recovery path.
- Agent creation now persists the selected model instead of dropping it, and
  browser sessions load pricing through a session-authenticated UI endpoint
  rather than the MCP-token endpoint.
- Changing a provider clears a known incompatible model while legacy
  model-only API and MCP updates continue to infer the provider when possible.
- The production build command no longer masks a failed asset-copy or build
  step, so CI reports genuine failures.

### Compatibility

- This release requires no database migration and does not rewrite task data.
  Existing agent assignments, unassigned tasks, custom model identifiers, and
  legacy model-only API payloads remain supported.

## [0.7.0] — 2026-07-28

### Added

- **People and AI agents now share one task assignee.** A project task can be
  owned by one company member, one agent, or nobody. Creating or editing a task
  uses one familiar assignee selector, and changing that value is the handoff
  between human and AI work.
- **Dashboard work filters** for **All work**, **My work**, **People**,
  **Agents**, and **Unassigned**, with filtered counts, activity, and links back
  to the matching Kanban work.
- **Unified assignee API shape.** Task responses add
  `assignee: { type: "human" | "agent", id } | null`, and member lookup
  responses expose the company `membershipId` used for human assignment.

### Changed

- Agent claiming will not take work assigned to a person or another agent.
  Reassignment revokes an incompatible agent lease so stale runtimes cannot
  continue work after a human/agent handoff.
- Removing a company member safely leaves their tasks unassigned.
- Operator, MCP, concepts, API, and usage documentation now describe people and
  agents as peers in the same work system.

### Compatibility

- Migration `0034_hybrid-task-assignees` is additive and preserves every
  existing `assignedAgentId`. Legacy task payloads and the agent-only assignment
  endpoint remain supported; new clients can adopt the unified `assignee`
  object incrementally.

### Fixed

- Docker builds now exclude host dependencies, generated Next.js output, local
  data, and browser-test artifacts. This prevents stale host build caches from
  leaking into release images and reduces the Docker build context
  substantially.

## [0.6.2] — 2026-07-24

### Fixed

- **Multi-user chat now works as shared channels with per-user read state.** Chat
  with an agent (and the team channel) is company-shared — every member sees the
  same conversation — but each user has their own unread count and read position.
  Several bugs made this unreliable:
  - `ensureDirectThread` overwrote the thread's human participant to whoever
    opened it last, clobbering everyone else's membership and read state. It now
    resolves one canonical thread per (company, agent) and never rewrites refs.
  - Duplicate `thread_participants` rows double-counted unread and left read
    state partially stuck — deduped and a unique index added (migration 0032).
  - A race in `ensureTeamThread` could create multiple team channels per company,
    splitting the conversation — consolidated into one, with a unique index
    (migration 0033).
  - Read timestamps were written as JS `Date` while message timestamps use DB
    `now()`; on a non-UTC server the skew broke unread. Read state now uses
    `now()` too.
  - Every company member is seeded a participant row (caught-up) on each shared
    thread, so per-user unread badges are correct.
- **Direct messages no longer leak into other agents' chats.** `GET
  /messages/sync` returned every human message in the company to every polling
  agent, with no thread scoping. A message addressed to one agent was picked up
  and answered by others, and because a reply reuses the payload's `threadId`,
  those replies landed in the wrong direct thread — so a reply appeared to
  vanish and re-appear in another agent's chat, as if sent by someone else. Sync
  is now scoped to the threads an agent belongs to: the shared team channel plus
  its own direct thread.

## [0.6.1] — 2026-07-22

### Fixed

- **Knowledge & Rules folders now behave like Storage — and adding a folder no
  longer hides your notes.** Creating a folder auto-selected it, and because it
  was empty the note list filtered down to nothing, so every existing note
  appeared to vanish. The sidebar was also two disconnected views (a folder
  filter-tree plus a separate scope list). Both are replaced by a single unified
  tree: **scope → nested folders → notes**, each folder expandable/collapsible,
  scoped per company/customer/project/agent. Right-click a folder for *New note
  here / New subfolder / Rename / move / Delete folder*, and a note for *Open /
  Delete note* — mirroring the Storage explorer. Delete-folder is scoped and
  confirmed. New API: `DELETE /api/resources/folders`; folder rename/delete now
  take an optional scope so identically-named folders in different scopes stay
  independent.

## [0.6.0] — 2026-07-22

Completes the Knowledge & Rules folders shipped in 0.5.0. In 0.5.0 folders
existed in the data model but you could only reach them by typing a path into a
text field, and three endpoints ignored `path` entirely.

### Added

- **Folder explorer in the Knowledge & Rules sidebar.** A real tree: expand and
  collapse folders, click one to filter to it and everything beneath it, with
  note counts per folder. "All notes" and "Unfiled" entries sit above it.
- **Create a folder from the UI.** A folder button in the sidebar header, plus
  **New subfolder** on a folder's right-click menu. Because folders are implicit,
  a new folder is held in the sidebar and becomes permanent as soon as a note is
  filed into it — and the next note you create is filed there automatically.
- **Rename or move a folder from the UI** via right-click → *Rename / move*,
  which re-files every note beneath it and reports how many moved.
- **New notes inherit the selected folder** instead of always landing at the root.

### Fixed

- **`path` was ignored by three resource-creating endpoints.** Notes created via
  `POST /api/mcp/projects/{projectId}/resources`, `POST /api/mcp/customers/{id}/resources`,
  or an approved resource proposal were always filed at the vault root, with no
  way to place them in a folder. All three now accept `path`, and proposal review
  accepts `pathOverride`. Folder support is now consistent across the API rather
  than present on only the two company-scoped routes.

### Documentation

- **Agent operating manual** documents Knowledge & Rules folders, with an
  explicit warning that they are *not* Storage folders — Storage uses real folder
  records and `folderId`, Knowledge & Rules uses the `path` string on the note.
  Sending `folderId` to a resource endpoint does nothing, and the manual
  previously documented only the Storage variant.
- **API reference** documents `path` on create/patch, the `path` and `pathPrefix`
  query filters, the derived `folders` tree in list responses, and the
  `/api/resources/folders` tree/rename endpoints.
- **Resources as wiki memory** gains a Folders section covering the
  implicit-folder model and how path differs from scope.

### Internal

- Path helpers moved to `src/lib/resource-paths.ts`, a database-free module, so
  the client component builds the same folder tree as the server instead of
  reimplementing it. `@/lib/resources` re-exports them, so server imports are
  unchanged.

## [0.5.0] — 2026-07-22

### Added

- **Folders in Knowledge & Rules.** Notes now carry an Obsidian-style `path`
  (`Company/Fundraising`, `Ferrari/Audits/2026-07`), so the Company Brain can be
  organised as a real vault instead of a flat list. Folders are *implicit* —
  a folder exists exactly as long as a note inside it does, so there are no
  empty folders to clean up and no folder table to keep in sync.
  - Set `path` on create or patch; patch it to `""`/`null` to move a note back
    to the root. Parent folders appear automatically.
  - `GET /api/mcp/resources` gains `path` (exact folder) and `pathPrefix`
    (whole subtree) filters, and returns a derived `folders` tree alongside
    `resources`.
  - New `GET /api/resources/folders` (tree with per-folder counts) and
    `POST /api/resources/folders` (rename/move a folder, re-filing every note
    beneath it). Moving a folder into its own subtree is rejected.
  - The Knowledge & Rules sidebar groups notes under folder headings, and the
    note **Properties** panel has a Folder field.
  - Paths are normalised on write (`/Ferrari/XXX`, `Ferrari/XXX/` and
    `Ferrari // XXX` all become `Ferrari/XXX`). Traversal segments (`.`, `..`)
    are stripped rather than resolved, since paths also drive prefix queries.
    Depth is capped at 10 segments, each at 80 characters.

- **`EMPEROR_BRAIN_MAX_CHARS_PER_RESOURCE`** to tune how much of a single
  Knowledge & Rules note is injected into agent context.

### Changed

- **Agent context no longer silently truncates doctrine at 3000 characters.**
  The per-note ceiling in the Company Brain resolver was hard-coded at 3000,
  while `maxChars` (default 12000) only capped the *total* across notes. Any
  longer note was cut off mid-document with no error surfaced anywhere — agents
  received the opening sections and confidently acted as if the rest did not
  exist, which is especially dangerous because the lost text is whatever was
  appended most recently. The default per-note ceiling is now 8000 and is
  configurable via `EMPEROR_BRAIN_MAX_CHARS_PER_RESOURCE` or a
  `maxCharsPerResource` query param on `GET /api/mcp/resources/context`.

  Splitting long doctrine into several cross-linked notes is still the better
  pattern — the resolver can then select the relevant one — but doing so is now
  a choice rather than a hidden requirement.

### Documentation

- Company Brain docs cover folders, path normalisation, the folder API, and the
  two distinct context limits, including a `curl` recipe for verifying what an
  agent actually receives instead of assuming a successful write was delivered.

### Added

- **"Generate token" button in the agent connect panel.** The quick-connect
  commands showed a `YOUR_TOKEN` placeholder; you can now mint a scoped access
  token inline (shown once) and it's inserted into the commands and `.env` —
  no need to detour to Settings → Access Tokens. (Also fixes "Copy all" copying
  a literal `{token}`.)

### Fixed

- **Signup/login no longer tell SMTP-less users to "verify your email."** When no
  email server is configured, accounts are auto-verified — but the UI still said
  a verification link would be sent and that new workspaces must verify first,
  making a successful self-hoster think they were locked out. The signup subtitle,
  the signup notice ("activated immediately"), and the login footer now reflect
  the real state via a new `emailConfigured` flag on `/api/auth/register-state`.

### Added

- **One-click cloud deploy (Render).** A `render.yaml` Blueprint + "Deploy to
  Render" button in the README provision managed Postgres, auto-generate the
  secrets, and need no URL input — so people can try EmperorClaw without local
  Docker (verified that login works behind a proxy with no `NEXTAUTH_URL` set).

## [0.4.1] — 2026-07-22

### Added

- **"Connect your first agent" quickstart** (`docs/CONNECT-FIRST-AGENT.md`,
  linked from the README) — gets an agent online and replying in ~5 minutes.

### Fixed

- **Multi-arch Docker image.** The published image was `linux/amd64` only, so a
  fresh `docker compose up` failed on Apple Silicon (arm64) with
  `no matching manifest`. The release now builds `linux/amd64,linux/arm64`.
- **`/api/health` and `/api/version` are reachable without auth.** The proxy
  (Next 16 middleware) matcher was redirecting these public endpoints to
  `/login`, which also silently defeated the Docker healthcheck. Added both to
  the public allowlist.
- **Docker healthcheck actually works now.** The container bound only to its
  container-ID hostname (not loopback), and the healthcheck used `localhost`
  (which resolves to IPv6 `::1`). Set `HOSTNAME=0.0.0.0` so the server binds all
  interfaces, and point the healthcheck at `127.0.0.1`. Verified end-to-end on a
  native arm64 build.

## [0.4.0] — 2026-07-22

### ⚠️ Breaking / action required

- **The in-app Update button and the entire `/ops` panel now require
  `EMPEROR_PLATFORM_ADMIN_EMAILS` to be set.** Previously `GET`/`POST
  /api/ops/update` — which runs shell commands, pulls container images, and
  talks to the Docker socket (root on the host) — was reachable by any
  authenticated user. It is now restricted to configured platform admins,
  matching the `/ops` UI. **Existing self-hosters must add their admin email to
  `.env`** (`EMPEROR_PLATFORM_ADMIN_EMAILS=you@yourcompany.com`) or `/ops` and
  the Update button will be unreachable. Fresh installs can pass
  `--admin-email` (bash) / `-AdminEmail` (PowerShell) to the installer. Updating
  from the shell (`scripts/update.sh`) is unaffected.

### Fixed

- **Fresh installs now get a complete database.** The migration chain was broken:
  migrations 0024–0029 were missing from the drizzle journal (silently skipped by
  `db:migrate`, which the Docker image runs on boot), lacked statement-breakpoints,
  and never added four `schema.ts` columns. A fresh install was missing tables
  (invitations, instance_settings, llm_pricing, token_usage_log, …) and columns,
  breaking registration outright. Journal + breakpoints repaired and idempotent
  migration 0030 added; a from-scratch `db:migrate` now reproduces `schema.ts`
  with zero drift. Existing (push-built) deployments re-apply these as a no-op.
- **Signup no longer requires SMTP.** When email is not configured, invited
  teammates and open self-hosted signups are auto-verified (previously they were
  sent a verification email that never arrived, locking them out permanently).
  The signup flow now sends such users straight to login. Configure SMTP to
  re-enable email verification and password resets.
- **Budgets now actually enforce on the Codex bridge.** It previously reported
  usage via `PATCH /agents/{id}`, which *overwrote* the running total, never
  recorded cost, and never flipped `budget_status` — so per-agent budgets were
  cosmetic for Codex agents. It now reports via `POST /agents/report-usage`
  (the same path the Hermes bridge uses), which increments usage, prices the
  input/output split against the pricing table, and pauses at 100%.
- **Bare-metal self-update targets the right directory.** `/api/ops/update` no
  longer hardcodes `/var/www/emperorclaw` (which mismatched the installer's
  `$HOME/emperorclaw`); it now uses the app's working directory, overridable
  with `EMPEROR_UPDATE_DIR`.
- Added an "Open detail" link from the agents list to the full agent page.

### Added

- **Automatic database backup before Docker self-updates.** The one-click
  Update (Docker path) now runs `pg_dump` inside the Postgres container and
  writes a snapshot to the persistent storage volume (`.data/storage/backups/`)
  before pulling the new image and running migrations. The update aborts if the
  backup fails; it is skipped with a warning for external/managed databases.
- Installer support for setting the platform admin email during setup
  (`install.sh --admin-email`, `install.ps1 -AdminEmail`).
- Unauthenticated `GET /api/health` liveness/readiness probe (returns 200 when
  the DB is reachable, 503 otherwise) plus a Docker Compose healthcheck on the
  app service.
- CI workflow (`.github/workflows/ci.yml`) running lint, typecheck, and tests on
  every push and pull request, plus an integration job with a Postgres service.
- Layered test suite (see `TESTING.md`): unit tests for billing/semver, a
  deterministic Codex-bridge reply-decision matrix (mock LLM), and in-process
  integration tests (register, report-usage, health) against real Postgres.
  `npm test` grew from ~42 to 118 always-run tests.

### Security

- Removed a hardcoded company API token from the test files and their production
  host defaults. **The leaked token remains in git history and must be revoked**
  (Settings → Access Tokens).

### Changed

- Removed the unused, inconsistent `computeBudgetStatus()` helper. Budget status
  is computed in exactly one place: `POST /api/mcp/agents/report-usage`.
- Clarified `.env.example`: only `NEXTAUTH_SECRET` and `EMPEROR_CLAW_MASTER_KEY`
  are truly required, and the installer generates both.
- Installer no longer passes a misleading `--build` flag (the default compose
  uses the prebuilt GHCR image); update hints now point at `scripts/update.sh`.
