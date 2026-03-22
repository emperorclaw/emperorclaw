# How Emperor Claw OS Works

Emperor Claw is the control plane.
OpenClaw is the runtime that executes work.
The skill package defines the contract between them, and the bridge examples show one way to wire a runtime to that contract.

## System Model

- Emperor Claw stores the source of truth for company state, tasks, incidents, scoped resources, artifacts, integrations, and durable checkpoints.
- OpenClaw reads from Emperor, performs work locally, and writes results back.
- WebSocket events are notifications and coordination signals, not a substitute for idempotent REST mutations.
- `/api/mcp/messages/sync` is fallback transport only when realtime connectivity is blocked.
- The local companion commands `bootstrap`, `doctor`, `sync`, `repair`, and `session-inspect` are operator tools for setup, diagnosis, and recovery.
- The bridge keeps a local state journal for cursors, reconnect backoff, and dedupe so reconnects do not duplicate writes.

## Bridge Contract

The shipped bridge is a reference adapter. It shows how to:
- register a runtime node
- resolve or create an agent record
- start and end a session
- hydrate memory from Emperor
- keep heartbeats alive so task leases can be renewed
- connect to the realtime WebSocket
- fall back to sync polling when the socket is unavailable
- claim tasks when queue pressure exists
- post honest notes/handoffs
- checkpoint memory
- send messages and status updates
- persist local state and resume from cursors instead of replaying blindly
- keep artifacts for important business files only
- lease customer/project scoped resources into runtime work instead of cloning permanent customer-facing agents

The bridge does not implement planning, model selection, task scheduling, or incident handling inside Emperor itself.
If no real executor is attached, it should say so rather than pretending to have finished the task.

## Runtime Loop

1. Register the runtime.
2. Resolve the agent identity.
3. Load durable memory and company context.
4. Start a session.
5. Connect to the WebSocket.
6. Read project memory and queued tasks.
7. Claim a task with a lease.
8. Heartbeat while work is active so the lease stays valid.
9. Post notes, messages, artifacts, or incidents as shared state changes.
10. Complete the task and checkpoint the result, or leave an explicit handoff if execution is deferred.
11. Persist the local state journal so the next reconnect can resume without duplicate work.

## Task Lifecycle

- `POST /api/mcp/tasks/claim` atomically claims a queued task.
- Heartbeat renews the lease for in-progress tasks assigned to the agent.
- `POST /api/mcp/tasks/{id}/result` records completion, failure, or review state.
- Notes and memory entries are durable control-plane records, not ephemeral chat-only state.
- The shipped bridge uses these endpoints honestly: it claims work, records the claim in notes/memory, and only reports completion if a real executor returns a result.
- The shipped bridge should treat reconnects as recoverable transport events, not new sessions by default. It should resume from saved cursors, then sync before claiming or sending anything new.

## Security

- API tokens are workspace-scoped and should be treated as secrets.
- Mutations require `Idempotency-Key` headers.
- The bridge uses outbound HTTP and WebSocket connections only.
- Resource scope should be preserved on artifacts, notes, and task results when the work is customer/project specific.
- Project agent profiles let one worker keep a stable runtime identity while still using a customer/project-facing display name, signature, and memory seed when needed.
