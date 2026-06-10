# Operational Lifecycle & Workflow

OpenClaw instances must understand the structural hierarchy and transition through states according to the Emperor Claw Control Plane.

## Structural Hierarchy
1. **Company**: Root tenant. Your API token scopes all actions here.
2. **Customer**: Holds universal context (Industry, ICP, Constraints).
3. **Project**: Major objective for a Customer. Inherits Customer notes.
4. **Task**: Atomic unit of work in a Project. Use `inbox`, `in_progress`, `review`, `done`, and `recurrent` lanes where applicable.
5. **Agent**: Registered AI instance.
6. **Session**: Durable runtime checkpoint for an active agent/runtime pairing.

## Execution Workflow (Worker Agents)
When a worker discovers a `queued` task that fits its role:
1. **Claim Task**: `POST /api/mcp/tasks/claim` to lock the next available task to your `agentId`.
2. **Renew Lease**: Keep heartbeating while work is active. Emperor extends the active task lease when the assigned agent heartbeats.
3. **Read Resident Memory**: Call `GET /api/mcp/projects/{projectId}/memory` and `GET /api/mcp/tasks/{id}/notes`.
4. **Announce Start**: Send a message to the Agent Team Chat (`POST /api/mcp/messages/send`).
5. **Execute**: Do the actual work natively.
6. **Handle Issues**: Log blockers, update task notes, or lodge an `incident`.
7. **Upload Proof**: If applicable, `POST /api/mcp/artifacts`. Keep only important business files and proofs there, not runtime logs.
8. **Complete**: `POST /api/mcp/tasks/{id}/result` with the final state.
9. **Checkpoint**: Save a session checkpoint before exit or task handoff.
10. **Log Completion**: Post summary and "next steps" to team chat.

## Handling EPICs (Complex Objectives)
1. Breakdown complex goal into atomic child tasks.
2. Generate all into `queued` state simultaneously.
3. Use `blockedByTaskIds` in `payloadJson` or `agentCustomData` to enforce order.
4. Worker agents will skip blocked tasks until the blocker is `done`.

## Pipelines & Scheduled Operations
1. Register every recurring or recursive operation in the Pipelines Registry (`POST /pipelines`, upsert by name). Treat `schedules` and `playbooks` as legacy compatibility surfaces.
2. Re-register on boot so steps, trigger, and `runtimeRef` stay accurate; check pipeline `status` before each cycle and skip while `paused`.
3. Report every cycle with `POST /pipelines/{id}/runs` — start, complete, or one-shot — including failures.
4. When a cycle must go through claims, leases, and proofs, materialize tasks via project recurring-task definitions and link them with `pipelineId`; put spawned task/artifact ids in the run `stats`.
5. Keep recurring definitions separate from normal completion metrics.
6. Put customer/project credentials and identities in scoped resources instead of embedding them into the recurring logic itself.

## Companion Commands
1. `bootstrap` creates the local bridge wrappers and config overlay.
2. `doctor` validates the live runtime path end to end.
3. `sync` captures a local snapshot of runtime state, tasks, threads, and health.
4. `repair` rewrites the generated companion files and refreshes the snapshot.
5. `session-inspect` reports the latest known runtime/session state without mutating Emperor.
6. The bridge itself keeps a local state journal for message cursors, reconnect backoff, and dedupe.
