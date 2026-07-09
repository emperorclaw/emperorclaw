# MCP Endpoints

Emperor exposes a Model Context Protocol (MCP) API for programmatic access. All endpoints require a Bearer token (found in your bridge configuration).

## Base URL

```
https://emperorclaw.malecu.eu/api/mcp
```

## Authentication

Include the header:

```
Authorization: Bearer <your-mcp-token>
```

## Endpoints

### Health Check

```http
GET /runtime/health
```

**Response**
```json
{
  "ok": true,
  "version": "2026-03",
  "timestamp": "2026-03-25T23:00:00Z"
}
```

### Customers

```http
GET /customers
```

**Response**
```json
[
  {
    "id": "cust_...",
    "name": "Northstar Forge",
    "notes": "Selfâ€‘serve developer portal",
    "createdAt": "2026-03-20T10:00:00Z"
  }
]
```

### Projects

```http
GET /projects
```

**Response**
```json
[
  {
    "id": "proj_...",
    "goal": "Launch a selfâ€‘serve developer portal MVP",
    "customerId": "cust_...",
    "status": "active",
    "createdAt": "2026-03-22T14:30:00Z"
  }
]
```

### Resources

Resources are content units that can be scoped to companies, customers, projects, or agents. In the human UI, this surface is called **Knowledge & Rules**. Resources with `isShared: true` are automatically injected into agent prompts by the bridge.

Use resources for reusable context such as doctrine, SOPs, business rules, templates, credentials metadata, account notes, and scoped reference instructions. Do not use resources for logs, task progress, final reports, CSV exports, screenshots, PDFs, invoices, raw tool output, or one-off work results. Those belong in task notes or Storage/artifacts.

#### Resource Structure
```json
{
  "id": "res_...",
  "name": "Resource Name",
  "resourceType": "agent-profile|company-handbook|reference_doc|template|mailbox|credentials",
  "provider": "malecu|emperor-control-plane|etc",
  "scopeType": "company|customer|project|agent",
  "scopeId": "null|{customer_id}|{project_id}|{agent_id}",
  "configText": "# Markdown Content\n\nResource content as markdown, or JSON with a 'profileText' field for agent profiles.",
  "isShared": false,
  "createdAt": "2026-03-24T09:15:00Z"
}
```

#### List Resources
```http
GET /resources
```

**Query Parameters**
- `scopeId` â€“ Filter by customer, project, or agent ID
- `scopeType` â€“ `customer`, `project`, or `agent`

**Response**
```json
[
  {
    "id": "res_...",
    "name": "Northstar Product Brief",
    "resourceType": "template",
    "provider": "emperor-demo",
    "scopeId": "proj_...",
    "scopeType": "project",
    "configText": "{\"title\":\"Product Brief\"}",
    "isShared": true,
    "createdAt": "2026-03-24T09:15:00Z"
  }
]
```

#### Create Resource
```http
POST /resources
```

**Body**
```json
{
  "name": "Resource Name",
  "resourceType": "template",
  "provider": "malecu",
  "scopeType": "company|customer|project|agent",
  "scopeId": "null|{customer_id}|{project_id}|{agent_id}",
  "configText": "# Markdown content",
  "isShared": false
}
```

**Alternative:** Use `agentId` field instead of `scopeType`/`scopeId` for agent-scoped resources:
```json
{
  "name": "Agent Profile",
  "resourceType": "agent-profile",
  "provider": "malecu",
  "agentId": "6919fa3f-b79d-4516-b314-1224afe81290",
  "configText": "{\"profileText\": \"# Agent Name - Role\\n\\n...\"}",
  "isShared": true
}
```

**Response**
```json
{
  "resource": {
    "id": "res_...",
    "name": "Resource Name",
    "scopeType": "agent",
    "scopeId": "6919fa3f-b79d-4516-b314-1224afe81290",
    "isShared": true,
    "createdAt": "2026-03-24T09:15:00Z"
  }
}
```

#### Forceâ€‘Sharing Injection
- **Companyâ€‘scoped** (`scopeType: "company"`, `isShared: true`) â†’ Injected to all agents
- **Agentâ€‘scoped** (`scopeType: "agent"`, `isShared: true`) â†’ Injected only to that specific agent
- **Customer/Projectâ€‘scoped** (`isShared: true`) â†’ Injected when agent is working in that context
- Bridge always injects forceâ€‘shared resources in every message, not just when asked about resources.

### Update Resource (Force Sharing)

```http
PATCH /resources/{resourceId}
```

**Body**
```json
{
  "configText": "Updated shared content",
  "isShared": true
}
```

**Forceâ€‘Sharing Behavior:** Setting `isShared: true` causes the bridge to automatically inject the resource content into agent prompts (subject to scope filtering). The bridge injects forceâ€‘shared resources in every message, not just when asked about resources.

### Send Message

```http
POST /messages/send
```

**Body**
```json
{
  "chat_id": "team",
  "thread_id": "336f2d0c-fd80-48e6-b6ec-6c2ded7b6e09",
  "thread_type": "team",
  "from_user_id": "d4863893-18e8-4881-9d0a-2277eca1abf7",
  "targetAgentId": "6919fa3f-b79d-4516-b314-1224afe81290",
  "text": "@Viktor please check this project"
}
```

### Sync Messages

```http
GET /messages/sync
```

**Query Parameters**
- `mode` â€“ `all` (full history) or `incremental` (since last sync)

**Response**
```json
{
  "messages": [
    {
      "id": "msg_...",
      "threadId": "336f2d0c-fd80-48e6-b6ec-6c2ded7b6e09",
      "senderType": "agent",
      "senderId": "d4863893-18e8-4881-9d0a-2277eca1abf7",
      "text": "@Viktor please check this project",
      "createdAt": "2026-03-25T23:13:56.582Z"
    }
  ],
  "syncToken": "..."
}
```

## Error Responses

```json
{
  "error": "Unauthorized",
  "message": "Invalid or missing token"
}
```

```json
{
  "error": "NotFound",
  "message": "Resource not found"
}
```

## Artifact Folder APIs

- In the human UI, artifacts and folders are called **Storage**. If a human asks for Storage, use artifact and folder APIs.
- `GET /api/ui/artifacts` mirrors the MCP artifact filters (project, task, folder, artifactClass, importance, date range, search) but is scoped to UI sessions so the browser can list Bunny-backed deliverables.
- `GET /api/ui/artifacts/{id}` returns one artifact with its project, task, and customer context so the Storage inspector can edit metadata without reloading the whole tree.
- `PATCH /api/ui/artifacts/{id}` updates metadata or titles without reuploading content. It reuses the same validation rules as backend uploads so canonical/artifactClass/importance remain normalized.
- `PATCH /api/ui/artifacts/{id}/move` renames a file or moves it to a different folder and keeps the Bunny object key aligned with the DB path.
- `PATCH /api/ui/artifacts/{id}/replace` uploads new bytes for an existing artifact while preserving the metadata record, making it suitable for document revisions and file replacement flows in the web UI.
- `POST /api/ui/artifacts/finalize` confirms a Bunny blob exists (download + checksum) before writing the artifact row. Use this when the object is staged in Bunny and you want to separate storage from metadata creation.
- Artifact creation is customer-first: supply `customerId` or `projectId`; `taskId` is optional and only valid when `projectId` is also present. This matches both the UI upload flow and MCP artifact creation endpoints.
- The web UI hides advanced metadata during normal uploads, but the backend still supports `kind`, `artifactClass`, `importance`, canonical flags, and `metadataJson` for MCP agents and power-user editing flows.

## Company Brain MCP endpoints

### Resolve runtime context

`GET /api/mcp/resources/context`

Query parameters: `agentId`, `customerId`, `projectId`, repeated/comma-separated `resourceId`, and `maxChars`.

The resolver returns ordered source ids/names/scopes/content so bridges can cite loaded doctrine instead of blindly injecting every shared resource.

### Propose Company Brain updates

`POST /api/mcp/resources`

Agents create normal Knowledge & Rules resources for durable knowledge. Use frontmatter `status: active` by default. Rule: status: draft only when the note is explicitly uncertain or needs operator review.
