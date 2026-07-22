# Changelog

All notable changes to EmperorClaw are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

At release time, rename the `## [Unreleased]` heading below to the version being
tagged (e.g. `## [1.2.0] — 2026-07-22`). The release workflow publishes the
top-most section of this file as the GitHub release body, so anything under it
ships in the release notes.

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
