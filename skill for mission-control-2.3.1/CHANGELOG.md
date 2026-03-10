# Changelog

All notable changes to Mission Control will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.3.0] - 2026-02-12

### Added

- **OpenClaw Gateway Integration** — All cron operations now use the `/tools/invoke` API endpoint instead of legacy REST calls
  - `gatewayInvoke()` — Universal gateway adapter with timeout, auth, and error handling
  - `probeGateway()` — Gateway reachability check via `/tools/invoke`
  - `extractInvokeData()` — Response mapper for tools/invoke format
  - `loadCronsFromGateway()` — Load crons directly from gateway (maps gateway format to dashboard format)
  - `autoProbeGateway()` — Auto-detect gateway from known URLs on startup
- **Gateway Token UI** — New "Gateway Token" field in Settings modal with show/hide toggle and save button
- **Gateway URL UI** — New "Gateway URL" field in Settings modal with connection test
- **CORS Proxy** — `scripts/cors-proxy.js` for cross-origin access when dashboard and gateway are on different origins
- **Gateway Setup Documentation** — `docs/gateway-setup.md` with full setup instructions

### Changed

- **Default port updated** — `18789` (OpenClaw default) replaces `3033`
- **Gateway-first cron loading** — Dashboard tries gateway first, falls back to GitHub if unavailable
- **Improved error messages** — Catch blocks now show actual error details instead of generic messages
- **URL query parameter support** — Pass `?gateway=http://...` to auto-configure gateway URL
- **CLI references updated** — All `clawdbot` references replaced with `openclaw`

### Migrated

- `POST /api/crons/:id/run` → `gatewayInvoke('cron', { action: 'run', jobId })`
- `PATCH /api/crons/:id` → `gatewayInvoke('cron', { action: 'update', jobId, patch })`
- `DELETE /api/crons/:id` → `gatewayInvoke('cron', { action: 'remove', jobId })`
- `POST /api/crons` → `gatewayInvoke('cron', { action: 'add', job })`

---

## [2.2.2] - 2026-02-10

### Security

- **User data excluded from version control** — `data/tasks.json` and `data/crons.json` added to `.gitignore` to prevent personal task data from being committed to the public repo
- **Demo data templates** — Renamed to `demo-tasks.json` and `demo-crons.json` as safe templates for new installations
- **Branch protection enabled** — Direct pushes to `main` blocked; PRs with review required

---

## [2.2.1] - 2026-02-07

### Security

- **Input sanitization in `mc-update.sh`** — Replaced heredoc-based Python interpolation with environment variable passing to prevent shell injection
- **`sanitize_input()` function** — Blocks backticks and `$` characters in all script arguments
- **Security documentation** — Added Security section to SKILL.md and README.md documenting the trust model, mitigations, and recommendations

---

## [2.2.0] - 2026-01-30

### Added

- **Version Update Banner** — Dashboard now shows a notification banner when a new version is available
  - Checks `data/version.json` every 5 minutes
  - Also checks when tab becomes visible again
  - Stylish gradient banner with refresh button
  - Dismissable (stops checking for current session)
- **`scripts/update-version.sh`** — Helper script to update version.json with current git hash
- **`data/version.json`** — Version tracking file with buildHash and buildTime

### Technical

- CSS styles for `.version-banner` with pulse animation
- `checkForUpdates()`, `showVersionBanner()`, `dismissVersionBanner()` JavaScript functions
- Cache-busting on version check requests
- Version check also triggers on `visibilitychange` event

---

## [2.1.0] - 2026-01-30

### Added

- **Recurring Column** — New "Recurring" column (leftmost) displays automated cronjobs from Clawdbot Gateway
- **Cron Cards** — Visual representation of cronjobs with:
  - Status indicator (🟢 active / ⚪ disabled / 🔴 error)
  - Human-readable schedule ("Täglich um 08:00", "Montags 08:00")
  - Last run and next run timestamps (relative time)
- **`data/crons.json`** — JSON data source for recurring jobs
- **`scripts/sync-to-opensource.sh`** — Exports sanitized crons for open source distribution

### Technical

- CSS styles for `.cron-card`, `.cron-status`, `.recurring-column`
- `loadCrons()` and `renderCrons()` JavaScript functions
- `formatCronExpression()` converts cron syntax to German-readable text

---

## [2.0.0] - 2026-01-30

### ⚠️ Breaking Changes

- **Config Location Changed** — Config now lives in `~/.clawdbot/mission-control.json` instead of being hardcoded
- **Transform Module Renamed** — Now uses `github-mission-control.mjs` (copy to `~/.clawdbot/hooks-transforms/`)
- **Setup Script Removed** — `scripts/mc-setup.sh` is deprecated; use agent-guided setup instead

### Added

- **Dynamic Configuration** — All settings loaded from `~/.clawdbot/mission-control.json`
- **Environment Variable Fallbacks** — Override config via `CLAWDBOT_GATEWAY`, `MC_WORKSPACE`, etc.
- **Agent-Guided Setup** — Say "Set up Mission Control" and the agent handles everything
- **EPIC Support** — Parent tasks can contain child tickets for sequential execution
- **Extended Timeouts for EPICs** — Automatically calculated based on number of children
- **Repo Info from Payload** — No more hardcoded GitHub URLs; extracted from webhook
- **New Documentation**:
  - `docs/PREREQUISITES.md` — Installation requirements
  - `docs/HOW-IT-WORKS.md` — Technical architecture
  - `docs/TROUBLESHOOTING.md` — 10 common issues with solutions
- **Example Configurations**:
  - `assets/examples/mission-control.json`
  - `assets/examples/CONFIG-REFERENCE.md`
  - `assets/examples/clawdbot-hooks-config.json`
  - `assets/examples/HOOKS-CONFIG.md`

### Changed

- **SKILL.md Rewritten** — Focus on agent-guided setup, removed manual steps
- **README.md Simplified** — Quick start section, badges, links to docs
- **Transform Location** — Moved to `assets/transforms/` for distribution

### Removed

- `scripts/mc-setup.sh` — Replaced by agent-guided setup
- Hardcoded paths, tokens, and URLs in transform module
- Manual webhook setup instructions (agent handles this now)

### Fixed

- GitHub API caching issues resolved via Git Blob API
- Snapshot desync on concurrent updates
- HMAC timing attacks prevented with `timingSafeEqual`

## [1.0.0] - 2026-01-28

Initial release.

### Added

- Kanban dashboard (single-page HTML app)
- GitHub Pages deployment
- `mc-update.sh` CLI tool
- Webhook integration with Clawdbot
- Diff-based change detection
- Auto-processing for "In Progress" tasks
- Subtask management
- Comment system
- Activity feed
- Search functionality
- Archive feature for completed tasks
