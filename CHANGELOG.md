# Changelog

All notable changes to EmperorClaw are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

At release time, rename the `## [Unreleased]` heading below to the version being
tagged (e.g. `## [1.2.0] — 2026-07-22`). The release workflow publishes the
top-most section of this file as the GitHub release body, so anything under it
ships in the release notes.

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
