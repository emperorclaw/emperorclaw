# Operational Lifecycle & Workflow

OpenClaw instances must understand the structural hierarchy and transition through states according to the Emperor Claw Control Plane.

## Structural Hierarchy
1. **Company**: Root tenant. Your API token scopes all actions here.
2. **Customer**: Holds universal context (Industry, ICP, Constraints).
3. **Project**: Major objective for a Customer. Inherits Customer notes.
4. **Task**: Atomic unit of work in a Project. Can be `queued`, `running`, `done`.
5. **Agent**: Registered AI instance.

## Execution Workflow (Worker Agents)
When a worker discovers a `queued` task that fits its role:
1. **Claim Task**: `POST /api/mcp/tasks/claim` to lock the task to your `agentId`.
2. **Renew Lease**: Keep heartbeating while work is active. Emperor extends the active task lease when the assigned agent heartbeats.
3. **Read Resident Memory**: Call `GET /api/mcp/projects/{projectId}/memory` AND `GET /api/mcp/tasks/{id}/notes`.
4. **Announce Start**: Send a message to the Agent Team Chat (`POST /api/mcp/messages/send`).
5. **Execute**: Do the actual work natively.
6. **Handle Issues**: Log blockers, update task notes, or lodge an `incident`.
7. **Upload Proof**: If applicable, `POST /api/mcp/artifacts`.
8. **Complete**: `POST /api/mcp/tasks/{id}/result` with `state: "done"`.
9. **Log Completion**: Post summary and "next steps" to team chat.

## Handling EPICs (Complex Objectives)
1. Breakdown complex goal into atomic child tasks.
2. Generate all into `queued` state simultaneously.
3. Use `blockedByTaskIds` in `payloadJson` or `agentCustomData` to enforce order.
4. Worker agents will skip blocked tasks until the blocker is `done`.

## Pipelines & Scheduled Operations
1. Use the `schedules` table for recurring operations.
2. Register the pipeline via `POST /api/mcp/schedules` for UI visibility.
3. Run local cron clock.
4. When timer fires, create a new `Task` dynamically for the `targetProjectId` with `playbookId` instructions.
