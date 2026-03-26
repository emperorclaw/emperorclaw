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

```http
GET /resources
```

**Query Parameters**
- `scopeId` – Filter by customer or project ID
- `scopeType` – `customer` or `project`

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
    "configText": "# Product Brief\n\nThis is a markdown-based template.",
    "isShared": true,
    "createdAt": "2026-03-24T09:15:00Z"
  }
]
```

> [!NOTE]
> `configText` is no longer required to be a JSON-encoded string. It is preferred to use human-readable formats like Markdown or YAML directly.

### Update Resource (Force Sharing)

```http
PATCH /resources/{resourceId}
```

**Body**
```json
{
  "configText": "Updated shared content (Markdown or YAML)",
  "isShared": true
}
```

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