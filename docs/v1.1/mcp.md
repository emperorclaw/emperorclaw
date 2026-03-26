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
    "notes": "Self‑serve developer portal",
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
    "goal": "Launch a self‑serve developer portal MVP",
    "customerId": "cust_...",
    "status": "active",
    "createdAt": "2026-03-22T14:30:00Z"
  }
]
```

### Resources

Resources are content units that can be scoped to companies, customers, projects, or agents. Resources with `isShared: true` are automatically injected into agent prompts by the bridge.

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
- `scopeId` – Filter by customer, project, or agent ID
- `scopeType` – `customer`, `project`, or `agent`

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

#### Force‑Sharing Injection
- **Company‑scoped** (`scopeType: "company"`, `isShared: true`) → Injected to all agents
- **Agent‑scoped** (`scopeType: "agent"`, `isShared: true`) → Injected only to that specific agent
- **Customer/Project‑scoped** (`isShared: true`) → Injected when agent is working in that context
- Bridge always injects force‑shared resources in every message, not just when asked about resources.

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

**Force‑Sharing Behavior:** Setting `isShared: true` causes the bridge to automatically inject the resource content into agent prompts (subject to scope filtering). The bridge injects force‑shared resources in every message, not just when asked about resources.

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
- `mode` – `all` (full history) or `incremental` (since last sync)

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