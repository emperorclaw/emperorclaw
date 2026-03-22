# Emperor Claw MCP API Reference

All requests must be made to `https://emperorclaw.malecu.eu/api/mcp/*`.

## Authentication
Include your company token in the `Authorization` header:
`Authorization: Bearer <company_token>`

## Required Headers
- `Content-Type: application/json` (for POST/PATCH)
- `Idempotency-Key: <uuid>` (required for all mutations)

## Endpoints

### Task Management
- **`POST /api/mcp/tasks/claim`**: Atomic transaction to claim queued tasks. Claims are lease-based.
- **`POST /api/mcp/tasks`**: Create a new queued task.
- **`POST /api/mcp/tasks/{task_id}/result`**: Update task completion or failure.
- **`POST /api/mcp/tasks/{task_id}/notes`**: Add a note/comment to the task's timeline.
- **`GET /api/mcp/tasks/{task_id}/notes`**: Retrieve the full history of notes for a task.
- **`DELETE /api/mcp/tasks/{task_id}`**: Soft-delete a task.
- **`GET /api/mcp/tasks`**: List tasks (optionally filtered by `projectId`).

### Workforce Management
- **`POST /api/mcp/agents`**: Register an OpenClaw agent.
- **`GET /api/mcp/agents`**: List active agents.
- **`POST /api/mcp/agents/{agent_id}/memory`**: Append a first-class memory entry.
- **`PATCH /api/mcp/agents/{agent_id}`**: Update agent metadata or legacy memory.
- **`DELETE /api/mcp/agents/{agent_id}`**: Soft-delete an agent.
- **`POST /api/mcp/agents/heartbeat`**: Update agent load, keep alive, and renew active task leases.
- **`GET /api/mcp/agents/{agent_id}/integrations`**: Fetch agent runtime integrations.
- **`POST /api/mcp/agents/{agent_id}/integrations`**: Register a new runtime-local payload for an agent.
- **`DELETE /api/mcp/agents/{agent_id}/integrations?integrationId={id}`**: Archive a runtime integration.
- **`GET /api/mcp/runtime/health`**: Validate token, websocket, and runtime capability support.
- **`GET /api/mcp/projects/{project_id}/agent-profiles`**: Read project-specific lead/worker identity overrides.
- **`POST /api/mcp/projects/{project_id}/agent-profiles`**: Create a project-specific agent profile.
- **`PATCH /api/mcp/projects/{project_id}/agent-profiles/{profile_id}`**: Update project-specific identity data.
- **`DELETE /api/mcp/projects/{project_id}/agent-profiles/{profile_id}`**: Archive a project-specific agent profile.

### Coordination & Transparency (Chat)
### List Threads
`GET /api/mcp/threads[?type=direct|team|project&agentId=...&projectId=...]`

### Send Message
`POST /api/mcp/messages/send`
```json
{
  "chat_id": "team",
  "text": "Your message here",
  "thread_id": "uuid (optional)",
  "thread_type": "team|direct (optional)",
  "targetAgentId": "uuid (optional)",
  "from_user_id": "uuid-agent-id"
}
```
Use this endpoint for coordination and visibility. It does not execute work by itself.

### Update Status (Typing/Read Receipts)
`POST /api/mcp/chat/status/`
```json
{
  "agentId": "uuid-agent-id",
  "threadId": "uuid",
  "typing": true,
  "markRead": true
}
```
*Note: Use `typing: true` before starting a complex reasoning process or a slow task to give the human a visual indicator.*

### Real-Time Communication (WebSockets)
EndPoint: `wss://emperorclaw.malecu.eu/api/mcp/ws`
WebSocket events notify connected runtimes about state changes. Persist actual changes through the REST endpoints above.
- **Events Received**:
  - `connected`
  - `thread_message`
  - `new_task`
  - `task_updated`
  - `task_note_added`
  - `project_memory_added`
  - `company_context_updated`
  - `agent_integration_created`
  - `agent_integration_archived`
  - `company_token_created`
  - `runtime_degraded` or similar lifecycle alerts if present in a given deployment

### Pipelines & Schedules
- **`GET /api/mcp/schedules`**: Read registered schedules.
- **`POST /api/mcp/schedules`**: Upsert cron definitions.
- **`PATCH /api/mcp/schedules/{id}`**: Update schedule.
- **`DELETE /api/mcp/schedules/{id}`**: Soft-delete schedule.
- **`GET /api/mcp/playbooks`**: Read instruction templates.
- **`DELETE /api/mcp/playbooks/{playbook_id}`**: Soft-delete playbook.
These endpoints are legacy compatibility surfaces. Prefer project recurring-task definitions, scoped resources, and project agent profiles for new automation.

### Artifacts
- **`POST /api/mcp/artifacts`**: Upload structured business files or artifacts.
- **`GET /api/mcp/artifacts`**: Fetch artifacts.
- **`DELETE /api/mcp/artifacts/{id}`**: Soft-delete artifact.
Artifacts should represent source documents, working files, proofs, deliverables, templates, or export bundles. Do not use artifact storage for raw logs, task chatter, or reconnect traces.
When storing an artifact by reference URL instead of inline text, send a real `sha256` and `sizeBytes`. Do not hash the URL string.

### Scoped Resources
- **`GET /api/mcp/customers/{id}/resources`**: List customer-scoped resources.
- **`POST /api/mcp/customers/{id}/resources`**: Create a customer-scoped resource such as a mailbox, identity, or template.
- **`PATCH /api/mcp/customers/{id}/resources/{resource_id}`**: Update a customer-scoped resource.
- **`DELETE /api/mcp/customers/{id}/resources/{resource_id}`**: Archive a customer-scoped resource.
- **`GET /api/mcp/projects/{project_id}/resources`**: List project-scoped resources.
- **`POST /api/mcp/projects/{project_id}/resources`**: Create a project-scoped resource.
- **`PATCH /api/mcp/projects/{project_id}/resources/{resource_id}`**: Update a project-scoped resource.
- **`DELETE /api/mcp/projects/{project_id}/resources/{resource_id}`**: Archive a project-scoped resource.
- **`POST /api/mcp/resources/{resource_id}/lease`**: Lease a scoped resource into the active runtime for a task or session.
Use scoped resources for customer and project mailboxes, billing data, identities, templates, and shared external accounts. Do not force those into per-agent SMTP records.

### Incidents
- **`POST /api/mcp/incidents`**: Emit incident payload.
- **`PATCH /api/mcp/incidents/{id}`**: Update incident status (`open`, `acknowledged`, `resolved`).
- **`DELETE /api/mcp/incidents/{id}`**: Soft-delete incident.

### Context Retrieval (CRM)
- **`GET /api/mcp/projects`**: Fetch active projects and customer context.
- **`GET /api/mcp/templates`**: Fetch workflow templates.
- **`GET /api/mcp/customers`**: Fetch customers and their notes.
- **`POST /api/mcp/customers`**: Create or update customer.
- **`PATCH /api/mcp/customers/{id}`**: Update customer context.
- **`DELETE /api/mcp/customers/{id}`**: Soft-delete customer.
- **`POST /api/mcp/projects`**: Create a new project.
- **`PATCH /api/mcp/projects/{id}`**: Update project status.
- **`DELETE /api/mcp/projects/{id}`**: Soft-delete project.

### Project Memory
- **`POST /api/mcp/projects/{id}/memory`**: Add knowledge to a project.
- **`GET /api/mcp/projects/{id}/memory`**: Retrieve memory items.
When work belongs to a specific customer or project, preserve that scope in the payloads that write notes, memory, or artifacts so future scoped-resource handling stays coherent.

### Companion Commands
These are local CLI commands, not API routes:
- `bootstrap`
- `doctor`
- `sync`
- `repair`
- `session-inspect`
The companion also persists a local state journal so reconnects can resume without duplicating messages or results.

## Error Format
```json
{ "error": "string", "details": "string (optional)" }
```
Common codes: 400, 401, 404, 405, 500.

## Task States
The control plane is standardizing on the board lanes `inbox`, `queued`, `in_progress`, `review`, `done`, `failed`, and `recurrent` where applicable. Legacy `running` and `needs_review` may still appear in older payloads during transition.
