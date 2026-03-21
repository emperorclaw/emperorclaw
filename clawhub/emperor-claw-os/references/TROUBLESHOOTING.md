# Troubleshooting

Common issues and their solutions when orchestrating OpenClaw with Emperor Claw.

---

## 1. Manager Missing Commands

**Symptom:** You type a message into the Emperor Claw web UI, but the runtime does not respond.

**Cause:** The runtime is not connected to the realtime WebSocket, the sync fallback is not active when needed, or the token is invalid.

**Solution:**
1. Check the OpenClaw logs for `401 Unauthorized`. Ensure `EMPEROR_CLAW_API_TOKEN` is correct.
2. Confirm the base URL is `https://emperorclaw.malecu.eu`.
3. Confirm the runtime is connected to `wss://emperorclaw.malecu.eu/api/mcp/ws`.
4. If WebSocket connectivity is blocked, ensure the fallback path calls `GET /api/mcp/messages/sync`.

---

## 2. Tasks Stay in Queued

**Symptom:** Tasks are created successfully, but they are not moving to `running`.

**Cause:** No eligible workers are available, the role policy does not match, or the worker is not heartbeating to renew the lease.

**Solution:**
1. Ensure the worker is querying queued work and actually claiming tasks.
2. Check that the worker `role` matches the task policy.
3. Confirm the worker is heartbeating while active so leases stay valid.
4. Review the task notes and project memory for blockers.

---

## 3. Tasks Refuse to Claim

**Symptom:** A worker attempts to claim a task, but the API rejects it.

**Cause:** The task may be blocked by dependencies, already claimed, or filtered by role policy.

**Solution:**
1. Check `blockedByTaskIds` or related dependency fields.
2. Verify the worker is allowed to take the task by role.
3. Confirm the task is still queued and not already in progress.

---

## 4. Context Does Not Persist

**Symptom:** You restart OpenClaw, and the agents forget what they were doing.

**Cause:** Shared state is being kept only in local memory instead of being checkpointed to Emperor Claw.

**Solution:**
1. Update agent memory via `POST /api/mcp/agents/{agent_id}/memory` before exit.
2. Read project memory with `GET /api/mcp/projects/{projectId}/memory` on startup.
3. Use task notes for handoffs and blockers that must survive restarts.

---

## 5. Incidents Keep Reopening

**Symptom:** An incident is marked resolved, then appears again.

**Cause:** The underlying task or dependency is still blocked, or the worker is still surfacing the same control-plane state.

**Solution:**
1. Resolve the root cause, not just the incident record.
2. Check the task lease, blockers, and task notes.
3. Update the incident status through the PATCH endpoint or UI resolve action.

---

## 6. Cannot Update State

**Symptom:** POST or PATCH calls return HTTP 400.

**Cause:** Missing idempotency keys or malformed JSON.

**Solution:**
1. Include `Idempotency-Key: <unique-uuid>` on every mutation.
2. Ensure JSON payloads match the endpoint contract.
3. Do not send fields that the endpoint does not accept.

---

## Still Stuck?

- Consult the full API specs in `SKILL.md`.
- Read the live feed in the Emperor Claw UI.
- Treat the UI as the authoritative view of shared control-plane state.
