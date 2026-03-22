# Changelog

All notable changes to the Emperor Claw OS skill will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.14.15] - 2026-03-22

### Changed
- Reframed agent integrations as optional runtime-local payloads instead of a primary home for customer mailboxes or project identities.
- Documented scoped Resources as the preferred place for shared mailboxes, identities, billing data, templates, and generic external accounts.
- Marked the old playbook/pipeline surface as legacy guidance and pushed new recurring automation toward projects and recurring-task definitions.
- Updated public install guidance so the setup path teaches Resources plus Runtime Integrations instead of SMTP-per-agent assumptions.

## [1.14.14] - 2026-03-22

### Changed
- Aligned the skill and installers with the next-wave scoped resource and artifact hygiene model.
- Documented bridge-local state journaling, bounded reconnect backoff, and dedupe requirements so reconnects do not replay the same writes.
- Updated the public install path to surface the companion state journal alongside the generated launchers.

## [1.14.12] - 2026-03-21

### Changed
- Added companion `sync`, `repair`, and `session-inspect` flows alongside `bootstrap` and `doctor`.
- Upgraded the shipped bridge examples into honest minimal runtime adapters that sync, claim, checkpoint, and record task notes without pretending to be full executors.
- Documented the new runtime/cooperation boundary and recurring-task definition workflow more explicitly.

## [1.14.11] - 2026-03-21

### Changed
- Renamed the ClawHub display name to `control-plane` while keeping the install slug stable as `emperor-claw-os`.

## [1.14.10] - 2026-03-21

### Changed
- Reframed the skill and bridge docs around Emperor as a durable control plane and checkpoint layer, with OpenClaw as the runtime that actually executes work.
- Clarified that WebSocket traffic is notification and coordination, not proof of execution by itself.
- Documented lease-based task claims, heartbeat renewal, and incident lifecycle expectations more explicitly.
- Documented the retirement of fake mission-style orchestration in favor of real project, task, and thread flows.

## [1.14.9] - 2026-03-21

### Changed
- Published the control-plane cleanup pass and the bridge/doc realignment for OpenClaw usage.

## [1.14.2] - 2026-03-20

### Added
- Shipped a runnable JavaScript bridge with launcher scripts for session bootstrap, memory sync, WebSocket connectivity, and action logging.

### Changed
- Formalized Emperor as the durable source of truth for agent memory, sessions, messages, and managed credential leasing.
- Standardized the public install slug on `emperor-claw-os` while keeping compatibility with the legacy registry alias.

## [1.14.1] - 2026-03-19

### Changed
- Documented `GET /api/mcp/schedules` pagination with `page` and `limit`.
- Clarified that schedules responses include pagination metadata and exclude soft-deleted rows.

## [1.10.0] - 2026-03-10

### Added
- Asset bundle package with a formal `assets/` directory and branding logo.
- API example suite with high-fidelity payloads for core MCP endpoints.
- CLI tooling through `scripts/ec-cli.sh`.
- Enhanced documentation that references the asset-driven structure.

## [1.9.0] - 2026-03-10

### Added
- Operational playbook guidance for agent experience.
- Quick-start activation guidance.
- Visual operational flow inside `SKILL.md`.
- Explicit worker execution workflow.
- Support guidance for blocked task chains and rework.
- Initial documentation suite for setup and troubleshooting.

## [1.8.0] - 2026-03-10

### Added
- Long-form transparency logging guidance.
- Sub-agent clarification as first-class agents with memory and records.

## [1.7.0] - 2026-03-05

### Added
- Agent memory API integration guidance for persistent cross-session scratchpad behavior.
