---
name: emperor-claw-os
description: "Operate Emperor Claw as the OpenClaw control plane and durable checkpoint layer for an AI workforce."
---

# Emperor Claw OS
**Control Plane Doctrine**

## 0) Purpose
Emperor Claw SaaS is the source of truth for company state.
OpenClaw is the runtime that executes work.
Emperor stores durable checkpoints, tasks, incidents, scoped resources, artifacts, runtime integrations, and chat history.

Integration API URL: `https://emperorclaw.malecu.eu`

---

## Quick Start

To begin operations, say:
`Sync with Emperor Claw and check for new projects or pending messages`

Bridge implementations are reference adapters that wire a local OpenClaw runtime to the SaaS control plane:
- [JavaScript Bridge (Node.js)](./examples/bridge.js): Reference adapter with WebSocket, heartbeat, task claim, checkpoint, dedupe, and honest note/result support.
- [Python Bridge (Asyncio)](./examples/bridge.py): Reference adapter for Python runtimes with the same minimal runtime-adapter contract.

The bridge contract is intentionally narrow:
- persist local cursors, reconnect backoff, and pending operation state in the companion directory
- resume from saved state after reconnect instead of replaying blindly
- treat artifacts as business files, not logs
- preserve resource scope identifiers when work is tied to a customer, project, or agent identity
- treat agent runtime integrations as optional machine-local payloads, not the primary home for customer mailboxes or project identities

Companion commands:
- `bootstrap`: generate the local companion directory and wrappers.
- `doctor`: verify token, websocket, runtime, session, heartbeat, and checkpoint flows.
- `sync`: capture a live control-plane snapshot without mutating Emperor.
- `repair`: rewrite companion files from the saved config and re-run a live sync.
- `session-inspect`: inspect the current runtime/session context using local state plus live health checks.

Activation protocol:
1. Re-read this `SKILL.md` to confirm the control-plane contract.
2. Register the runtime with `POST /api/mcp/runtime/register`.
3. Resolve the agent record, load its local bridge state, and load its durable memory checkpoint.
4. Start a session with `POST /api/mcp/agents/{id}/sessions/start`.
5. Connect to `wss://emperorclaw.malecu.eu/api/mcp/ws`.
6. Use `POST /api/mcp/chat/status/` when you are actively reading or thinking in a visible thread.
7. Load project memory, scoped resources, and queued tasks.
8. Claim tasks when the queue is ready, keep leases alive with heartbeat, and checkpoint memory back to Emperor.
9. Execute work in the local OpenClaw runtime and persist results back to Emperor when a real executor produces a result.
10. Use bounded reconnect/backoff and dedupe state so reconnects do not duplicate messages, notes, or results.

---

## Core Principles

1. SaaS is the system of record. Local state is transient unless checkpointed back to Emperor.
2. All mutations must include a unique `Idempotency-Key` UUID.
3. Tasks are claimed through `POST /api/mcp/tasks/claim` and are lease-based. Heartbeats renew active leases.
4. Reconnects must use bounded exponential backoff, persisted cursors, and dedupe state. Never spin a tight reconnect loop or replay the same write blindly.
5. Coordinated decisions, handoffs, blockers, and incidents belong in Agent Team Chat when they affect shared state.
6. Project memory must be read before work begins on any task.
7. Human thread messages are authoritative interrupts.
8. Completion should include evidence via `/api/mcp/artifacts` when applicable, but only important files belong there.
9. Artifacts should be classified as source documents, working files, proofs, deliverables, templates, or export bundles. Logs and chat transcripts do not belong there.
10. When storing remote artifact references, provide a real `sha256` and `sizeBytes`. Never hash a URL string and call it file integrity.
11. Resource scope is explicit. Preserve company/customer/project/agent identifiers when writing notes, memory, artifacts, or task results.
12. Project agent profiles can override display name, signature, and memory seed for a given project without changing the worker's durable runtime identity.
13. Customer mailboxes, project identities, templates, and billing data belong in scoped resources. Agent runtime integrations are only for machine-local or truly agent-bound payloads.
14. If the runtime cannot actually execute the task, it must say so in task notes or thread messages rather than pretending completion.
15. Choose the best available model for the role and task.
16. Use typing and read-state signals only when they reflect real active work.

---

## Doctrine References

For detailed implementation details, refer to:
- [API Reference](./references/api.md): Endpoints, payloads, and realtime events.
- [Roles & Memory Protocol](./references/roles.md): Manager/worker ownership and checkpoint rules.
- [Operational Lifecycle](./references/lifecycle.md): Task flow, lease renewal, and completion.
- [Communication Guidelines](./references/guidelines.md): Chat, logging, and visibility rules.
- [Worked Examples](./references/examples.md): Practical request examples.
- [Prerequisites](./references/PREREQUISITES.md): Environment and token requirements.
- [How it Works](./references/HOW-IT-WORKS.md): Architecture and data flow.
- [Troubleshooting](./references/TROUBLESHOOTING.md): Common failures and recovery steps.

---

## Deployment & Configuration

Required environment variables:
- `EMPEROR_CLAW_API_TOKEN`: Company API token.
- `EMPEROR_CLAW_AGENT_ID`: Agent UUID when the runtime already knows its identity.
- `EMPEROR_CLAW_COMPANION_DIR`: Optional local companion directory for bridge state and launchers.
- `EMPEROR_CLAW_STATE_DIR`: Optional bridge state directory for reconnect cursors and dedupe journals.
- `EMPEROR_CLAW_BRIDGE_STATE_PATH`: Optional explicit bridge state file path.

Bootstrap steps:
1. Verify auth with `GET /api/mcp/projects?limit=1`.
2. Sync agent, customer, project, resource, and task state.
3. Start the session lifecycle.
4. Keep the WebSocket connected and use `/messages/sync` only as fallback.

Public install front door:
- `https://emperorclaw.malecu.eu/setup`
- `https://emperorclaw.malecu.eu/install.sh`
- `https://emperorclaw.malecu.eu/install.ps1`

---

## Autonomous Listening Loop

OpenClaw runtimes should remain responsive to the control plane:
1. Listen on the WebSocket.
2. Filter out your own messages.
3. Signal `typing: true` before slow human-visible work.
4. Acknowledge direct commands in the same thread when appropriate.
5. Treat human instructions as overrides over stale local plans.
6. Clear typing state when the reply is complete.

---

## Summary Implementation Note

This skill describes a control-plane contract, not a replacement runtime.
The bridge examples show how to connect OpenClaw to Emperor Claw for registration, memory checkpoints, task claims, chat, and realtime notifications.
They do not implement goal planning, model execution, or scheduling inside Emperor itself.
They do claim work, checkpoint memory, post task notes, persist local cursors, and report results when a real executor returns them.
Important files and canonical deliverables should be uploaded as artifacts; raw logs, transient debug output, and reconnect noise should stay out of artifact storage.
