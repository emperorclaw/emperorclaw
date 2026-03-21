# OpenClaw Alignment

This document records the current product direction for Emperor Claw and the cleanup that brought the repo back into alignment with OpenClaw.

## Product Position

Emperor Claw should behave as:

- a durable control plane
- a task and incident ledger
- a credential and integration manager
- a visibility and audit surface
- a checkpoint layer for agent and project memory

Emperor Claw should not behave as:

- a fake planner that invents work outside the runtime
- a replacement for OpenClaw's local execution model
- a guarantee that chat visibility equals real execution
- a source of truth that silently mutates identity on bad inputs

## Runtime Contract

- OpenClaw executes work locally.
- Emperor stores durable state and emits realtime notifications.
- The WebSocket is notification-first. Agents still need to claim tasks, update threads, report results, and renew leases explicitly.
- Human commands should arrive in real thread surfaces and be treated as authoritative interrupts.

## Memory Contract

- Every agent should treat Emperor as durable cross-session memory.
- Emperor memory is a checkpoint and audit surface, not a substitute for all local working memory inside OpenClaw.
- Project memory should be read before task execution and updated when new durable context is produced.

## Task Contract

- Tasks are claimed only through the MCP claim endpoint.
- Claims are lease-based.
- Heartbeats renew the lease for active in-progress tasks.
- Watchdog requeues expired tasks when retries remain.
- Watchdog dead-letters tasks that exceed retry limits and opens incidents.
- Task lifecycle changes should be broadcast back over WebSocket so the runtime and UI can reconcile quickly.

## Incident Contract

- Incidents are real lifecycle records, not just warnings.
- Current statuses are `open`, `acknowledged`, and `resolved`.
- The UI can resolve incidents.
- MCP clients can update incidents directly.
- Incident creation and resolution should fan out over WebSocket so OpenClaw can react.

## Chat Contract

- Team chat is a transparency surface.
- Direct agent threads are the correct surface for human-to-agent control.
- Thread ownership must be enforced by company.
- Returning a stored message is not the same thing as proving an agent executed work.

## Features Retired On Purpose

- The old "What is the mission for today?" flow was retired because it created fake plans, fake roles, and fake execution signals outside the real OpenClaw contract.
- Mission-style orchestration endpoints now return `410 Gone`.

## Fixes Landed

- Invalid MCP agent ids no longer auto-register ghost agents by default.
- MCP token verification no longer scans or logs token-hash material incorrectly.
- Task claims now use longer leases and heartbeats renew them.
- Task archive, retry, dead-letter, and incident changes now emit realtime events.
- Incident resolution now exists in both web and MCP paths.
- Setup and skill docs now describe the WebSocket-first model honestly.
- The Windows skill publish wrapper now works without manual command surgery.

## Remaining Priorities

- Unify the remaining legacy team-chat feed with the newer thread model.
- Reduce older `any`-heavy UI code in large surfaces like projects.
- Decide how much of Emperor's memory doctrine should be mandatory versus advisory for third-party OpenClaw runtimes.
- Keep removing surfaces that imply Emperor itself is the autonomous planner.

## Files To Read First

- [README.md](./README.md)
- [OPENCLAW_ALIGNMENT.md](./OPENCLAW_ALIGNMENT.md)
- [SKILL.md](./clawhub/emperor-claw-os/SKILL.md)
- [api.md](./clawhub/emperor-claw-os/references/api.md)
- [lifecycle.md](./clawhub/emperor-claw-os/references/lifecycle.md)
