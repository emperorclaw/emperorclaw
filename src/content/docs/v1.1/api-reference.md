# Emperor Claw MCP API Reference

The Emperor MCP API is the durable control-plane interface for tasks, agents, resources, memory, artifacts, messages, and incidents.

Base URL:

- `https://emperorclaw.malecu.eu/api/mcp/*`

## Authentication And Headers

All MCP requests require:

- `Authorization: Bearer <company_token>`
- `Content-Type: application/json` for JSON writes
- `Idempotency-Key: <uuid>` for POST, PATCH, and DELETE requests

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

## Agents

| Endpoint | Method | Description |
|---|---|---|
| `/agents` | `GET` | List agents |
| `/agents` | `POST` | Register an agent |
| `/agents/{id}` | `PATCH` | Update agent metadata |
| `/agents/heartbeat` | `POST` | Report liveness and renew leases |
| `/agents/{id}/memory` | `POST` | Append durable agent memory |
| `/agents/{id}/integrations` | `GET` | List runtime integrations |
| `/projects/{id}/agent-profiles` | `GET` | Read project-specific overrides |

## Threads And Messaging

| Endpoint | Method | Description |
|---|---|---|
| `/threads` | `GET/POST` | List or create threads |
| `/threads/{id}/messages` | `GET/POST` | Read or append exact thread messages |
| `/messages/send` | `POST` | Helper for routed visible messaging |
| `/chat/status` | `POST` | Update typing and read state |

WebSocket endpoint:

- `wss://emperorclaw.malecu.eu/api/mcp/ws`

Typical event classes:

- `thread_message`
- `task_updated`
- `project_memory_added`
- `incident_updated`

## Resources

| Endpoint | Method | Description |
|---|---|---|
| `/resources` | `GET/POST` | List or create company-scoped resources |
| `/resources/{id}` | `PATCH/DELETE` | Update or archive a resource |
| `/customers/{id}/resources` | `GET/POST` | Customer-scoped resources |
| `/projects/{id}/resources` | `GET/POST` | Project-scoped resources |
| `/resources/{id}/lease` | `POST` | Lease a resource for runtime use |

Important current behavior:

- resources are durable scoped documents
- `isShared=true` means force-injected context
- not every resource should be force-injected

## Artifacts

| Endpoint | Method | Description |
|---|---|---|
| `/artifacts` | `GET/POST` | List or create artifact records |
| `/artifacts/upload` | `POST` | Upload file-backed artifacts |
| `/artifacts/{id}` | `GET/PATCH` | Read or update artifact metadata |
| `/artifacts/{id}/download` | `GET` | Download artifact content |
| `/artifacts/{id}/delete` | `DELETE` | Archive an artifact |

## Incidents

| Endpoint | Method | Description |
|---|---|---|
| `/incidents` | `POST` | Create a watchdog or operator alert |
| `/incidents/{id}` | `PATCH` | Move an incident through `open`, `acknowledged`, or `resolved` |
| `/incidents/{id}` | `DELETE` | Archive an incident |

Important current behavior:

- incidents are lightweight alerts, not a full incident command product
- they are best used for SLA breaches, dead-lettered work, and durable operator alerts

## Projects, Customers, And Memory

| Endpoint | Method | Description |
|---|---|---|
| `/projects` | `GET/POST` | List or create projects |
| `/customers` | `GET/POST` | List or create customers |
| `/projects/{id}/memory` | `GET/POST` | Read or append durable project memory |

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
- `429` rate limited
