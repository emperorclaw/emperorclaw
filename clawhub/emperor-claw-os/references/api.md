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
- **`GET /api/mcp/tasks/{task_id}`**: Fetch canonical task detail, including project/customer context and normalized task fields derived from `inputJson`.
- **`GET /api/mcp/tasks/{task_id}/context`**: Fetch a task context bundle with task detail, task notes/events, recent project memory, relevant scoped resources, related threads, and project-specific agent profile when available.
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

### Artifacts & Folders
#### Folder endpoints
- **`POST /api/mcp/folders`**: Create a folder.
- **`GET /api/mcp/folders/{id}`**: Read folder metadata.
- **`PATCH /api/mcp/folders/{id}`**: Rename/update folder metadata or move it under a new parent.
- **`DELETE /api/mcp/folders/{id}`**: Soft-delete a folder.
- **`GET /api/mcp/folders/{id}/contents`**: List child folders and artifacts in a folder.

#### Artifact endpoints
- **`POST /api/mcp/artifacts`**: Create an artifact record directly.
- **`POST /api/mcp/artifacts/upload`**: Upload a file-backed artifact via multipart form-data.
- **`GET /api/mcp/artifacts`**: Search/list artifacts. Supported filters include `projectId`, `taskId`, `folderId`, `customerId`, `agentId`, `kind`, `artifactClass`, `importance`, `contentType`, `isCanonical`, `search`, `startDate`, `endDate`.
- **`GET /api/mcp/artifacts/{id}`**: Read artifact metadata.
- **`PATCH /api/mcp/artifacts/{id}`**: Update artifact metadata.
- **`POST /api/mcp/artifacts/{id}/move`**: Move an artifact into another folder/path.
- **`POST /api/mcp/artifacts/{id}/replace`**: Replace an artifact's file/blob while preserving metadata identity.
- **`GET /api/mcp/artifacts/{id}/download`**: Download the artifact content.
- **`DELETE /api/mcp/artifacts/{id}/delete`**: Soft-delete artifact.

Artifacts should represent source documents, working files, proofs, deliverables, templates, statements, invoices, expense documents, or export bundles. Do not use artifact storage for raw logs, task chatter, or reconnect traces.

Artifacts are no longer required to belong to both a project and task. They may be scoped at the company, customer, project, task, agent, or folder level depending on the work. Use the narrowest durable scope that makes sense.

Folders are first-class and should be used intentionally. Prefer creating folders and placing artifacts into them instead of relying on flat uploads.

New file-backed artifacts should default to Bunny-backed storage via the upload endpoints. Emperor DB remains the metadata/search/permissions layer; Bunny stores the blob contents.

`POST /api/mcp/artifacts/upload` expects multipart form-data with:

- required: `file`, `kind`, and one of `projectId` or `customerId`
- optional: `taskId`, `folderId`, `title`, `artifactClass`, `importance`, `contentType`, `metadataJson`, `agentId`, `visibility`, `retentionPolicy`, `checksum`
- rule: `taskId` requires `projectId`

Canonical tenant-safe Bunny keys follow this shape:

```text
companies/<companyId>/artifacts/<logical-path>
```

Visible logical paths should remain human-readable, for example:

```text
artifacts/malecu/2026/2026-03/invoices/2026-03-10-invoice-2026-0001-northstar-forge.pdf
```

### Scoped Resources
- **`GET /api/mcp/resources`**: List all reachable resources. Supported query params: `customerId`, `projectId`, `agentId`, `scopeType`, `scopeId`, `resourceType`, `provider`, `name`, `displayName`, `search` (or `q`), `status`, `isShared`.
- **`GET /api/mcp/customers/{id}/resources`**: List customer-scoped resources. Supports same search/filter params as global list.
- **`POST /api/mcp/customers/{id}/resources`**: Create a customer-scoped resource. Accepts `configText` (markdown) and `secretText`.
- **`PATCH /api/mcp/customers/{id}/resources/{resource_id}`**: Update a customer-scoped resource.
- **`DELETE /api/mcp/customers/{id}/resources/{resource_id}`**: Archive a customer-scoped resource.
- **`GET /api/mcp/projects/{project_id}/resources`**: List project-scoped resources. Supports search/filter params.
- **`POST /api/mcp/projects/{project_id}/resources`**: Create a project-scoped resource.
- **`PATCH /api/mcp/projects/{project_id}/resources/{resource_id}`**: Update a project-scoped resource.
- **`DELETE /api/mcp/projects/{project_id}/resources/{resource_id}`**: Archive a project-scoped resource.
- **`POST /api/mcp/resources/{resource_id}/lease`**: Lease a scoped resource into the active runtime for a task or session.
Use scoped resources for customer and project mailboxes, billing data, identities, templates, and shared external accounts. Note: Resource types are dynamic, and metadata configuration uses Markdown text strings instead of strict JSON objects (`configText` and `secretText`). The `isShared` (Force Sharing) flag can be used to explicitly pass a resource to every agent in the scope regardless of standard access policies.

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
