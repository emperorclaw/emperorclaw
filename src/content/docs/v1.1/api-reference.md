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
| `/artifacts` | `GET/POST` | List artifacts or create metadata/external-reference records |
| `/artifacts/upload` | `POST` | Upload file-backed artifacts |
| `/artifacts/{id}` | `GET/PATCH` | Read or update artifact metadata |
| `/artifacts/{id}/download` | `GET` | Download artifact content |
| `/artifacts/{id}/delete` | `DELETE` | Archive an artifact |

Important storage rule:

- new artifact bytes should go through `/artifacts/upload`
- `/artifacts` should be treated as metadata/external-reference creation, not inline blob storage
- inline `contentText` storage for new artifact content is disabled on the MCP create route

### Uploading File-Backed Artifacts

`POST /artifacts/upload` uses `multipart/form-data`.

Required parts:

- `file`: binary file payload
- `kind`: human-meaningful artifact kind such as `invoice`, `report`, `proposal`, `proof`, or `statement`
- one of `projectId` or `customerId`

Important constraints:

- `taskId` requires `projectId`
- `folderId` must resolve to an existing active folder
- uploaded bytes are stored in Bunny; Emperor stores metadata, indexing, permissions, and routing
- use `Idempotency-Key` on MCP writes, including multipart uploads

Optional parts:

- `projectId`
- `taskId`
- `customerId`
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

Common classification values:

- `artifactClass`: `working_file`, `deliverable`, `source_document`, `proof`, `template`, `export_bundle`
- `importance`: `operational`, `record`, `canonical`, `temporary`

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

Behavior summary:

- use `/artifacts/upload` when you are creating a new file-backed artifact
- use `/artifacts` when you are creating metadata around already-stored external content
- use `/artifacts/{id}` when you are editing metadata only
- use `/artifacts/{id}/replace` when new bytes should replace the existing artifact identity
- use `/artifacts/{id}/move` when the file should stay the same but move folder/path

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
