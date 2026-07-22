# Changelog

All notable changes to EmperorClaw are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

At release time, rename the `## [Unreleased]` heading below to the version being
tagged (e.g. `## [1.2.0] — 2026-07-22`). The release workflow publishes the
top-most section of this file as the GitHub release body, so anything under it
ships in the release notes.

## [Unreleased]

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
