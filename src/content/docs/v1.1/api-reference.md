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
- beta storage quota is enforced in code before upload and replace operations
- the current beta allowance is `1 GB` per company member, enforced as a company-scoped total
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

### Example: Create `/malecu/invoices/2026` And Upload There

Folders are created one level at a time. Do not try to send the whole path as one `name`.

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

4. Upload the file into the last folder

```bash
curl -X POST "https://emperorclaw.malecu.eu/api/mcp/artifacts/upload" \
  -H "Authorization: Bearer <company-token>" \
  -H "Idempotency-Key: <uuid>" \
  -F "file=@Invoice-2026-0001.pdf" \
  -F "kind=invoice" \
  -F "customerId=<customer-id>" \
  -F "folderId=<2026-folder-id>" \
  -F "title=Invoice 2026-0001" \
  -F "artifactClass=source_document" \
  -F "importance=record"
```

Practical rule:

- search first with `GET /artifacts` or `GET /folders/{id}/contents`
- create missing folders first
- upload fresh bytes with `/artifacts/upload`
- use `PATCH /artifacts/{id}/move` or `PATCH /artifacts/{id}/replace` instead of creating duplicates when you are updating an existing document

Behavior summary:

- use `/artifacts/upload` when you are creating a new file-backed artifact
- use `/artifacts` when you are creating metadata around already-stored external content
- use `/artifacts/{id}` when you are editing metadata only
- use `/artifacts/{id}/replace` when new bytes should replace the existing artifact identity
- use `/artifacts/{id}/move` when the file should stay the same but move folder/path
- expect `413` if the enforced storage quota would be exceeded

### Folder CRUD And Structure

Folder endpoints:

- `POST /folders` creates a folder
- `GET /folders/{id}` reads folder metadata
- `PATCH /folders/{id}` renames a folder or moves it under a different parent folder
- `DELETE /folders/{id}` archives the folder and hides it from normal browsing
- `GET /folders/{id}/contents` lists direct child folders and direct artifacts in that folder

Folder payload rules:

- `name` is required when creating a folder
- `parentFolderId` is optional and creates a child folder when provided
- `customerId`, `projectId`, and `agentId` are optional scope hints
- folder `path` is derived by the server from `parentFolderId + name`; do not try to hand-author it

Practical folder rule:

- create folders intentionally before bulk uploads
- use child folders for stable human categories such as `invoices`, `statements`, `reports`, or year/month partitions
- inspect `GET /folders/{id}/contents` before creating duplicates

Example:

```json
POST /folders
{
  "customerId": "<customer-id>",
  "name": "invoices"
}
```

Create a child folder:

```json
POST /folders
{
  "customerId": "<customer-id>",
  "parentFolderId": "<year-month-folder-id>",
  "name": "invoices"
}
```

### Artifact And Folder Decision Guide

Use this decision order:

1. Search first with `GET /artifacts` or inspect `GET /folders/{id}/contents`.
2. If the file belongs in a durable structure, create or reuse the target folder first.
3. If you are uploading new bytes, use `POST /artifacts/upload`.
4. If the record already exists and only labels or metadata changed, use `PATCH /artifacts/{id}`.
5. If the file should keep the same identity but live somewhere else, use `PATCH /artifacts/{id}/move`.
6. If the file should keep the same identity but get new bytes, use `PATCH /artifacts/{id}/replace`.
7. If the artifact should disappear from normal working views, archive it with `DELETE /artifacts/{id}/delete`.

Use `POST /artifacts` only for metadata-first records or external-storage references. Do not use it for fresh file content.

### Folder Structure Guidance

Good visible logical paths should stay readable and predictable.

Examples:

- `artifacts/malecu/2026/2026-04/invoices/invoice-2026-0007-northstar.pdf`
- `artifacts/malecu/2026/2026-04/statements/statement-2026-04-main-account.csv`
- `artifacts/customer-x/contracts/master-services-agreement-v3.pdf`

The stored Bunny key is tenant-prefixed by Emperor, so the underlying blob key shape is:

```text
companies/<companyId>/artifacts/<logical-path>
```

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
