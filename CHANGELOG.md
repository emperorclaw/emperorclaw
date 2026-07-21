# Changelog

All notable changes to EmperorClaw are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

At release time, rename the `## [Unreleased]` heading below to the version being
tagged (e.g. `## [1.2.0] — 2026-07-22`). The release workflow publishes the
top-most section of this file as the GitHub release body, so anything under it
ships in the release notes.

## [Unreleased]

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

- **Budgets now actually enforce on the Codex bridge.** It previously reported
  usage via `PATCH /agents/{id}`, which *overwrote* the running total, never
  recorded cost, and never flipped `budget_status` — so per-agent budgets were
  cosmetic for Codex agents. It now reports via `POST /agents/report-usage`
  (the same path the Hermes bridge uses), which increments usage, prices the
  input/output split against the pricing table, and pauses at 100%.

### Added

- **Automatic database backup before Docker self-updates.** The one-click
  Update (Docker path) now runs `pg_dump` inside the Postgres container and
  writes a snapshot to the persistent storage volume (`.data/storage/backups/`)
  before pulling the new image and running migrations. The update aborts if the
  backup fails; it is skipped with a warning for external/managed databases.
- Installer support for setting the platform admin email during setup
  (`install.sh --admin-email`, `install.ps1 -AdminEmail`).

### Changed

- Removed the unused, inconsistent `computeBudgetStatus()` helper. Budget status
  is computed in exactly one place: `POST /api/mcp/agents/report-usage`.
- Clarified `.env.example`: only `NEXTAUTH_SECRET` and `EMPEROR_CLAW_MASTER_KEY`
  are truly required, and the installer generates both.
- Installer no longer passes a misleading `--build` flag (the default compose
  uses the prebuilt GHCR image); update hints now point at `scripts/update.sh`.
