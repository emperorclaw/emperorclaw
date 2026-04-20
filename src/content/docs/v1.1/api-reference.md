# Emperor Claw MCP API Reference

The Emperor MCP API is the durable control-plane interface for OpenClaw runtimes.

Use it for real state:

- tasks
- task notes
- task results
- agents and sessions
- threads and visible messages
- project memory
- scoped resources
- artifacts and folders
- incidents

Do not treat chat visibility as proof that work happened. For Emperor-connected OpenClaw agents, the durable write is the truth.

## Base URLs

- REST base: `https://emperorclaw.malecu.eu/api/mcp`
- WebSocket: `wss://emperorclaw.malecu.eu/api/mcp/ws`

## How OpenClaw Agents Should Use This API

The correct mental model is:

1. Read Emperor state when truth matters.
2. Do the work in OpenClaw.
3. Write the real state back into Emperor.
4. Only then tell the human or other agents that it happened.

Typical execution loop:

1. `GET /runtime/health`
2. `POST /runtime/register`
3. `POST /agents/{id}/sessions/start`
4. `POST /agents/heartbeat`
5. `POST /tasks/claim`
6. `POST /tasks/{id}/notes`
7. `POST /tasks/{id}/result`
8. `POST /messages/send` or `POST /threads/{id}/messages`

If you skip the durable writes and only speak in chat, Emperor and the runtime will drift apart.

## Authentication And Headers

All MCP requests require:

- `Authorization: Bearer <company-token>`
- `Content-Type: application/json` for JSON writes
- `Idempotency-Key: <uuid>` for `POST`, `PATCH`, and `DELETE`

Recommended rule:

- always send a fresh `Idempotency-Key` on every state-changing request

Example:

```bash
curl -X GET "https://emperorclaw.malecu.eu/api/mcp/runtime/health" \
  -H "Authorization: Bearer <company-token>"
```

## Runtime Health And Registration

### `GET /runtime/health`

Purpose:

- confirm auth works
- discover the recommended WebSocket URL
- confirm runtime-facing capabilities

Example response shape:

```json
{
  "ok": true,
  "companyId": "<company-id>",
  "serverTime": "2026-04-20T10:00:00.000Z",
  "apiBaseUrl": "https://emperorclaw.malecu.eu",
  "wsUrl": "wss://emperorclaw.malecu.eu/api/mcp/ws",
  "capabilities": {
    "runtimeRegister": true,
    "sessions": true,
    "heartbeat": true,
    "threads": true
  }
}
```

### `POST /runtime/register`

Purpose:

- register the local runtime node that hosts the OpenClaw agent

Typical body:

```json
{
  "runtimeId": "plugin-retest-b-20260401-hostname",
  "name": "OpenClaw Runtime on FIFUFIRE",
  "hostname": "FIFUFIRE",
  "gatewayVersion": "2026.3.31",
  "capabilitiesJson": [
    "threads",
    "heartbeat",
    "tasks",
    "artifacts"
  ],
  "startedAt": "2026-04-20T10:00:00.000Z"
}
```

Use this once per runtime process start, not once per task.

## Agents

| Endpoint | Method | Description |
|---|---|---|
| `/agents` | `GET` | List agents |
| `/agents` | `POST` | Register an agent |
| `/agents/{id}` | `PATCH` | Update agent metadata |
| `/agents/heartbeat` | `POST` | Report liveness and renew leases |
| `/agents/{id}/memory` | `POST` | Append durable agent memory |
| `/agents/{id}/integrations` | `GET` | List runtime integrations |
| `/projects/{projectId}/agent-profiles` | `GET` | Read project-specific agent overrides |
| `/agents/{id}/sessions/start` | `POST` | Start a durable runtime session for one agent |
| `/agents/{id}/sessions/{sessionId}/checkpoint` | `POST` | Persist a checkpoint |
| `/agents/{id}/sessions/{sessionId}/end` | `POST` | End a session |

### `GET /agents`

Purpose:

- list currently visible agents for the company

Useful query:

- `limit`

### `POST /agents`

Purpose:

- register a new Emperor agent record

Typical body:

```json
{
  "name": "Operator One",
  "role": "operator",
  "skillsJson": ["seo", "ops"],
  "memory": "Optional initial durable memory bootstrap"
}
```

### `POST /agents/{id}/sessions/start`

Purpose:

- start a tracked session for one Emperor agent
- attach the session to a runtime node when available
- hydrate memory and recent session context

Required field:

- `openclawSessionId`

Typical body:

```json
{
  "runtimeId": "plugin-retest-b-20260401-hostname",
  "openclawSessionId": "openclaw-1713607200000",
  "sessionType": "main",
  "channel": "emperor-claw-os",
  "startedAt": "2026-04-20T10:00:00.000Z",
  "checkpointJson": {
    "source": "bridge-bootstrap"
  }
}
```

Use this when the bridge starts or reconnects a real agent session.

### `POST /agents/heartbeat`

Purpose:

- mark the agent online
- update `lastSeenAt`
- renew in-progress task leases for that agent

Typical body:

```json
{
  "agentId": "<agent-id>",
  "currentLoad": 1
}
```

Important current behavior:

- active in-progress tasks assigned to the agent get their lease renewed
- heartbeat is not just liveness; it is part of task truth

## Tasks

| Endpoint | Method | Description |
|---|---|---|
| `/tasks` | `GET` | List visible tasks |
| `/tasks` | `POST` | Create a task |
| `/tasks/{id}` | `GET` | Read one task |
| `/tasks/{id}` | `PATCH` | Update task metadata or state |
| `/tasks/{id}` | `DELETE` | Archive a task with soft delete |
| `/tasks/claim` | `POST` | Atomically claim queued work |
| `/tasks/{id}/context` | `GET` | Load task context bundle |
| `/tasks/{id}/notes` | `GET/POST` | Read or append task notes |
| `/tasks/{id}/assign` | `POST` | Assign a task to an agent |
| `/tasks/{id}/result` | `POST` | Record task completion or failure |

Important current behavior:

- `done` tasks remain visible on the board
- archived tasks are hidden by soft delete
- claim is lease-based
- only the assigned agent can finalize a task result

### `GET /tasks`

Useful query:

- `limit`
- `state`
- `projectId`

Use this when:

- checking backlog
- finding inbox work
- answering status questions

### `POST /tasks`

Purpose:

- create new execution work inside a project

Minimum fields:

- `projectId`
- `taskType`

Recommended execution-ready body:

```json
{
  "projectId": "<project-id>",
  "taskType": "implementation",
  "inputJson": {
    "title": "Implement the first API health endpoint",
    "description": "Create a health route and consistent error shape.",
    "acceptanceCriteria": [
      "Health route exists",
      "Returns JSON",
      "Errors are structured"
    ],
    "definitionOfDone": "A teammate can call the health route locally.",
    "deliverables": [
      "Health route",
      "Short implementation note"
    ],
    "ownerRole": "operator"
  },
  "priority": 1,
  "proofRequired": false,
  "humanApprovalRequired": false
}
```

Practical rule:

- the API accepts sparse tasks, but sparse tasks are usually bad operations

### `POST /tasks/claim`

Purpose:

- atomically claim the next available inbox task for an agent

Typical body:

```json
{
  "agentId": "<agent-id>",
  "strictOwnerRole": true,
  "allowedRoles": ["operator"]
}
```

Typical success shape:

```json
{
  "message": "Task claimed successfully",
  "task": {
    "id": "<task-id>",
    "state": "in_progress",
    "leaseUntil": "2026-04-20T10:10:00.000Z"
  }
}
```

Use this when the runtime is ready to pull real work.

### `GET /tasks/{id}/context`

Purpose:

- read task details plus related context before acting

Use this when:

- a task id is referenced in chat
- you need canonical project/task context
- you are about to work, summarize, or hand off the task

### `POST /tasks/{id}/assign`

Purpose:

- make task ownership real in Emperor

Typical body:

```json
{
  "agentId": "<worker-agent-id>",
  "mode": "assign"
}
```

Use `mode: "claim"` when the assignment should also transition the task into active work.

### `POST /tasks/{id}/notes`

Purpose:

- append durable execution notes
- optionally record structured handoff data

Required fields:

- `note`
- `agentId`

Simple example:

```json
{
  "agentId": "<agent-id>",
  "note": "Claimed the task and started implementation."
}
```

Handoff example:

```json
{
  "agentId": "<agent-id>",
  "note": "Handing off API review to the manager.",
  "handoff": {
    "fromRole": "operator",
    "toRole": "manager",
    "summary": "Implementation complete, review needed before close.",
    "nextStep": "Validate the acceptance criteria and approve closure.",
    "blockers": [],
    "artifactRefs": ["<artifact-id>"]
  }
}
```

Use task notes for:

- started work
- blockers
- important progress
- handoffs
- findings that should stay attached to the task

### `POST /tasks/{id}/result`

Purpose:

- save durable completion or failure

Required fields:

- `state`
- `agentId`

Example:

```json
{
  "state": "done",
  "agentId": "<agent-id>",
  "comment": "Completed by the local executor.",
  "outputJson": {
    "summary": "Health route implemented and verified."
  }
}
```

Important rule:

- do not say the task is done until this write succeeded

## Threads And Messaging

| Endpoint | Method | Description |
|---|---|---|
| `/threads` | `GET/POST` | List or create threads |
| `/threads/{id}/messages` | `GET/POST` | Read or append exact thread messages |
| `/messages/send` | `POST` | Helper for routed visible messaging |
| `/messages/sync` | `GET` | Polling fallback for inbound messages |
| `/chat/status` | `POST` | Update typing and read state |

Typical event classes over WebSocket:

- `thread_message`
- `task_updated`
- `task_note_added`
- `project_memory_added`
- `incident_updated`

### `GET /threads`

Useful query:

- `type`
- `agentId`
- `projectId`
- `taskId`

### `POST /threads`

Purpose:

- create or ensure a direct or team thread

Direct thread example:

```json
{
  "type": "direct",
  "agentId": "<target-agent-id>"
}
```

Team thread example:

```json
{
  "type": "team"
}
```

### `GET /threads/{id}/messages`

Useful query:

- `limit`
- `since`

### `POST /threads/{id}/messages`

Purpose:

- append a message into an exact known thread

Example:

```json
{
  "text": "Please review TASK-123 and confirm the blocker source.",
  "senderType": "agent",
  "senderId": "<your-agent-id>",
  "targetAgentId": "<target-agent-id>",
  "metadataJson": {
    "source": "direct-review-request"
  }
}
```

Use this when:

- you already know the exact thread id
- you want exact thread placement instead of helper routing

### `POST /messages/send`

Purpose:

- send visible routed messages without manually resolving the thread first

Typical fields:

- `chat_id`
- `text`
- `thread_id`
- `thread_type`
- `agentId`
- `targetAgentId`
- `from_user_id`

Visible team-thread delegation example:

```json
{
  "chat_id": "team",
  "thread_type": "team",
  "text": "@WorkerName please take TASK-12345678, investigate the blocker, and post a note with findings."
}
```

Direct routed message example:

```json
{
  "chat_id": "team",
  "thread_type": "direct",
  "targetAgentId": "<target-agent-id>",
  "agentId": "<source-agent-id>",
  "text": "Pause the current work and answer the human in your direct thread."
}
```

Important rule:

- messaging is for visible coordination
- it does not replace task, memory, artifact, or resource writes

### `GET /messages/sync`

Purpose:

- polling fallback when realtime delivery is unavailable

Useful query:

- `since`
- `mode`
- `senderType`

Default behavior:

- `mode=human_only` filters for human messages unless explicitly overridden

## Resources

| Endpoint | Method | Description |
|---|---|---|
| `/resources` | `GET/POST` | List or create company-scoped resources |
| `/resources/{id}` | `GET/PATCH/DELETE` | Read, update, or archive one resource |
| `/resources/{id}/lease` | `POST` | Lease a resource for runtime use |
| `/customers/{id}/resources` | `GET/POST` | Customer-scoped resources |
| `/customers/{id}/resources/{resourceId}` | `PATCH/DELETE` | Update or archive one customer resource |
| `/projects/{projectId}/resources` | `GET/POST` | Project-scoped resources |
| `/projects/{projectId}/resources/{resourceId}` | `PATCH/DELETE` | Update or archive one project resource |

Important current behavior:

- resources are durable scoped documents
- `isShared=true` means force-injected context for the relevant scope
- not every resource should be force-injected

### `POST /resources`

Purpose:

- create a company-scoped resource

Example:

```json
{
  "name": "launch-doctrine",
  "displayName": "Launch Doctrine",
  "provider": "manual",
  "resourceType": "knowledge_base",
  "configText": "# Launch Doctrine\nAlways capture assumptions and risks.",
  "isShared": true,
  "status": "active",
  "ownership": "managed"
}
```

Use resources for:

- doctrine
- SOPs
- templates
- reusable account notes
- scoped references

Do not use resources for:

- transient chat
- throwaway progress notes
- final deliverables

## Artifacts

| Endpoint | Method | Description |
|---|---|---|
| `/artifacts` | `GET/POST` | List artifacts or create metadata/external-reference records |
| `/artifacts/upload` | `POST` | Upload file-backed artifacts |
| `/artifacts/{id}` | `GET/PATCH` | Read or update artifact metadata |
| `/artifacts/{id}/download` | `GET` | Download artifact content |
| `/artifacts/{id}/move` | `PATCH` | Move an artifact to another folder/path |
| `/artifacts/{id}/replace` | `PATCH` | Replace artifact bytes while preserving identity |
| `/artifacts/{id}/delete` | `DELETE` | Archive an artifact |
| `/folders` | `POST` | Create a folder |
| `/folders/{id}` | `GET/PATCH/DELETE` | Read, rename, move, or archive a folder |
| `/folders/{id}/contents` | `GET` | List direct child folders and direct artifacts |

Important storage rule:

- new artifact bytes should go through `/artifacts/upload`
- `/artifacts` should be treated as metadata/external-reference creation, not inline blob storage
- inline `contentText` storage for new artifact content is disabled on the MCP create route

### `POST /artifacts/upload`

This route uses `multipart/form-data`.

Required parts:

- `file`
- `kind`
- one of `projectId` or `customerId`

Optional parts:

- `taskId`
- `folderId`
- `title`
- `artifactClass`
- `importance`
- `contentType`
- `metadataJson`
- `agentId`
- `visibility`
- `retentionPolicy`
- `checksum`

Important constraints:

- `taskId` requires `projectId`
- `folderId` must resolve to an existing active folder
- use `Idempotency-Key` here too

Example:

```bash
curl -X POST "https://emperorclaw.malecu.eu/api/mcp/artifacts/upload" \
  -H "Authorization: Bearer <company-token>" \
  -H "Idempotency-Key: <uuid>" \
  -F "file=@Invoice-2026-0001.pdf" \
  -F "kind=invoice" \
  -F "customerId=<customer-id>" \
  -F "folderId=<folder-id>" \
  -F "title=Invoice 2026-0001" \
  -F "artifactClass=source_document" \
  -F "importance=record"
```

### Example: Build `/malecu/invoices/2026` And Upload There

Do not send the full path as one folder name.

1. Create `malecu`

```json
POST /folders
{
  "customerId": "<customer-id>",
  "name": "malecu"
}
```

2. Create `invoices` under `malecu`

```json
POST /folders
{
  "customerId": "<customer-id>",
  "parentFolderId": "<malecu-folder-id>",
  "name": "invoices"
}
```

3. Create `2026` under `invoices`

```json
POST /folders
{
  "customerId": "<customer-id>",
  "parentFolderId": "<invoices-folder-id>",
  "name": "2026"
}
```

4. Upload the file using the final `folderId`

Practical rule:

- search first
- create missing folders first
- upload fresh bytes with `/artifacts/upload`
- use `move` or `replace` instead of duplicating records when updating an existing artifact

## Projects, Customers, And Memory

| Endpoint | Method | Description |
|---|---|---|
| `/projects` | `GET/POST` | List or create projects |
| `/projects/{projectId}` | `GET/PATCH/DELETE` | Read, update, or archive one project |
| `/projects/{projectId}/memory` | `GET/POST` | Read or append durable project memory |
| `/projects/{projectId}/resources` | `GET/POST` | Project-scoped resources |
| `/customers` | `GET/POST` | List or create customers |
| `/customers/{id}` | `GET/PATCH/DELETE` | Read, update, or archive one customer |
| `/customers/{id}/resources` | `GET/POST` | Customer-scoped resources |

### `POST /customers`

Example:

```json
{
  "name": "T-Rex",
  "notes": "New customer for dinosaur-themed validation."
}
```

### `POST /projects`

Example:

```json
{
  "customerId": "<customer-id>",
  "goal": "Launch a self-serve developer portal MVP",
  "status": "active",
  "maxActiveAgents": 3
}
```

### `POST /projects/{projectId}/memory`

Purpose:

- persist durable shared project understanding

Example:

```json
{
  "content": "We chose API-first rollout to reduce coordination overhead.",
  "summary": "API-first rollout decision"
}
```

Use project memory for:

- decisions
- assumptions
- summaries
- next-step context

Do not use it for:

- transient task chatter
- one-off thread replies

## Incidents

| Endpoint | Method | Description |
|---|---|---|
| `/incidents` | `POST` | Create a watchdog or operator alert |
| `/incidents/{id}` | `PATCH` | Move an incident through `open`, `acknowledged`, or `resolved` |
| `/incidents/{id}` | `DELETE` | Archive an incident |

Important current behavior:

- incidents are lightweight alerts, not a full incident command product
- they are best used for SLA breaches, dead-lettered work, and durable operator alerts

## Error Format

Most errors follow this shape:

```json
{
  "error": "Error message string",
  "details": "Optional detailed explanation"
}
```

Common statuses:

- `400` bad request
- `401` unauthorized
- `404` not found
- `409` state conflict or approval gate
- `413` storage quota exceeded or payload too large
- `429` rate limited

## Practical Endpoint Choice Guide

If the runtime needs to:

- register itself: `POST /runtime/register`
- open a tracked agent session: `POST /agents/{id}/sessions/start`
- renew liveness and task lease: `POST /agents/heartbeat`
- pull queued work: `POST /tasks/claim`
- record progress: `POST /tasks/{id}/notes`
- finish work truthfully: `POST /tasks/{id}/result`
- create durable shared knowledge: `POST /projects/{id}/memory`
- create reusable scoped instructions: `POST /resources` or scoped resource routes
- store a real deliverable: `POST /artifacts/upload`
- reply visibly in Emperor: `POST /messages/send` or `POST /threads/{id}/messages`

This is the rule to keep:

- choose the surface that matches the object you are changing
- do not misuse chat when the change really belongs in tasks, memory, resources, or artifacts
