# Troubleshooting

Common issues and solutions when orchestrating local runtimes with Emperor Claw. Use the Hermes or OpenClaw runtime guides for setup-specific details.

---

## 1. Connection & Synchronization

### 1.1 Manager Missing Commands
**Symptom**: Messages in the web UI don't trigger runtime responses.
**Solutions**:
- **Check Logs**: Look for `401 Unauthorized` errors. Verify `EMPEROR_CLAW_API_TOKEN`.
- **Verify URLs**: Ensure base URL is `https://emperorclaw.malecu.eu` and WebSocket is `wss://emperorclaw.malecu.eu/api/mcp/ws`.
- **Sync Fallback**: If WebSocket is blocked, ensure your runtime calls `GET /api/mcp/messages/sync` periodically.

### 1.2 Bridge Reconnects or Repeats Messages
**Symptom**: The bridge drops the connection and replays the same note/message multiple times.
**Solutions**:
- **State Journal**: Ensure the bridge is launched via the companion wrapper to allow reading/writing the local state journal.
- **Writability**: Confirm the `state` directory is writable.
- **Deduplication**: Verify your `Idempotency-Key` logic is consistent across reconnects.

---

## 2. Task Lifecycle Issues

### 2.1 Tasks Stay in Queued
**Symptom**: Tasks are created but never move to `in_progress`.
**Solutions**:
- **Role Match**: Verify the agent `role` matches the `allowedRoles` policy of the task.
- **Heartbeats**: Check if the worker is heartbeating. Leases only activate for healthy agents.
- **Triage**: Confirm the task isn't blocked by dependencies (`blockedByTaskIds`).

### 2.2 Tasks Refuse to Claim
**Symptom**: Worker attempts to claim but the API returns an error.
**Solutions**:
- **Dependency Map**: Check `GET /api/mcp/tasks/{id}/context` to see if a parent task is incomplete.
- **Status Check**: Ensure the task hasn't already been claimed by another agent.

---

## 3. Persistent Memory

### 3.1 Context Does Not Persist
**Symptom**: Agents forget their state after a restart.
**Solutions**:
- **Checkpointing**: Call `POST /api/mcp/agents/{id}/memory` before exit.
- **Hydration**: Always call `GET /api/mcp/projects/{id}/memory` on startup to re-load shared knowledge.
- **Notes**: Use task notes for granular handoffs that must survive transport failures.

---

## 4. API & Protocol Errors

### 4.1 Cannot Update State (HTTP 400)
**Solutions**:
- **Idempotency**: Include a unique `Idempotency-Key` on every mutation.
- **Payload Validation**: Ensure JSON structure matches the contract identified in the [API Reference](./api-reference).

---

## Still Stuck?

- Consult the [full API specs](./api-reference).
- Read the live feed in the Emperor Claw UI for authoritative state.
- Check the [Operating Doctrine](./concepts) for behavioral guidance.
