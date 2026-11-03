# MCP Endpoints

Emperor exposes two different things under the "MCP" name — read this section first so you connect the right one.

## Connecting an MCP Client (Claude, Codex, etc.)

Emperor runs a real, spec-compliant Model Context Protocol server at `/mcp` (not under `/api/mcp` — that's the legacy REST API documented below). Point any MCP-capable client at it and it discovers agent, task, project, Knowledge & Rules, messaging, and group-chat tools automatically, plus a company-specific `instructions` block with your operating doctrine — no per-client setup needed beyond the token.

Every client gets the same tools: the server does not tell Claude and Codex apart. Generate an **Agent access** token from **Settings → Access Tokens** for the token-based setups below (Settings → Access Tokens → "Connect Claude, Codex, or another MCP client" shows them with your host filled in).

**Claude Code**

```bash
claude mcp add --transport http emperorclaw https://your-emperorclaw-host/mcp --header "Authorization: Bearer <your token>"
```

Add `--scope user` to use it in every project. Run `/mcp` inside Claude Code to check that it connected.

**Codex (CLI and IDE extension)** — add this to `~/.codex/config.toml` and set `EMPEROR_CLAW_TOKEN` to your token in the environment Codex starts from:

```toml
[mcp_servers.emperorclaw]
url = "https://your-emperorclaw-host/mcp"
bearer_token_env_var = "EMPEROR_CLAW_TOKEN"
```

Or let Codex write the same entry: `codex mcp add emperorclaw --url https://your-emperorclaw-host/mcp --bearer-token-env-var EMPEROR_CLAW_TOKEN`.

**Claude Desktop and claude.ai (Connectors)** — open **Customize → Connectors**, choose **+ Add → Add custom connector**, and paste the server URL (`https://<your-emperorclaw-host>/mcp`). Leave sign-in on: Emperor implements OAuth 2.1 + PKCE with dynamic client registration (RFC 7591/8414/9728), so Claude registers itself automatically and you approve the connection while logged in — no Client ID/Secret, no token to copy. To use a token instead, choose **No sign in** and add a request header `Authorization` with the value `Bearer <your token>`.

> [!IMPORTANT]
> Claude connects to custom connectors from **Anthropic's cloud**, not from your computer, so your instance must be reachable from the internet over **HTTPS** with a real certificate (Caddy, nginx, Cloudflare Tunnel, etc.). OAuth 2.1 also requires TLS on every authorization-server endpoint; a plain-HTTP install (the self-hosted default — `docker-compose.yml` ships `APP_URL=http://localhost:3000`) will very likely fail partway through, even if the consent screen itself loads. The `/authorize` page shows a warning if it detects this. For an instance on a private network or plain HTTP, use Claude Code, Codex, or the Claude Desktop config below — they connect from your machine.

**Claude Desktop with a private or plain-HTTP instance** — Claude Desktop's `claude_desktop_config.json` only starts local servers (a `url`/`headers` entry there does nothing), so start [`mcp-remote`](https://github.com/geelen/mcp-remote) (needs Node.js) to forward to Emperor. Quit Claude Desktop, open **Settings → Developer → Edit Config**, add:

```json
{
  "mcpServers": {
    "emperorclaw": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://192.168.1.20:3000/mcp", "--header", "Authorization:${EMPEROR_AUTH}", "--allow-http"],
      "env": {
        "EMPEROR_AUTH": "Bearer <your token>"
      }
    }
  }
}
```

The header value goes through `env` because Claude Desktop on Windows does not escape spaces in `args`. Keep `--allow-http` only for a plain-HTTP URL on a network you trust; drop it for an `https://` URL.

### Talking to an agent from Claude or Codex

A connection with no agent bound (an operator connection) talks to the agents:

1. `send_message` with `targetAgentId` posts in that agent's direct thread and returns `threadId` and `messageId`.
2. `wait_for_reply` with `threadId` and `afterMessageId` waits up to 25 seconds (default 20) and returns the new messages the caller did not send, oldest first. On `timedOut: true`, call it again. Agents often post a short acknowledgement (`ack: true`) first; keep waiting with `afterMessageId` set to `nextAfterMessageId` for the answer.
3. `read_thread` (by `threadId`, or by `agentId` for that agent's direct thread) returns the conversation, oldest first, with `since`, `before` and `limit` (default 30, max 100). `list_threads` shows each thread's last message.

For work you want tracked to done (a task with status and output), use `send_agent_request` and poll `get_agent_request` (filter by `status` or `externalRef`, up to 50 results).

A person's private chat with an agent (private direct-chat mode) is never readable from an operator connection, and an agent-bound connection reads only what its agent may read: the same rules as `GET /api/mcp/threads/{id}/messages`. Agent-bound connections get `read_thread` and `wait_for_reply` too, for their own direct and pair threads, groups they belong to, and the team chat.

OAuth and a copied token produce the exact same token type (visible and revocable from Settings → Access Tokens either way) — OAuth is just an automated way to get one without copy-pasting.

**Hermes agents** connect to this same server automatically during provisioning — see [Hermes Agent Runtime](/docs/v1.1/hermes-runtime) — so this section is mainly for external clients like Claude or Codex.

## Legacy REST API (`/api/mcp/*`)

Everything below this point documents the plain REST API under `/api/mcp/*`, used by the Hermes plugin's `emperor_request` tool and OpenClaw bridges — not the real MCP protocol above. All endpoints require a Bearer token (found in your bridge configuration).

### Base URL

```
https://emperorclaw.example.com/api/mcp
```

## Authentication

Include the header:

```
Authorization: Bearer <your-mcp-token>
```

A company-wide token (one not bound to an agent) can act as any agent by naming it with `?agentId=`, so it can read whatever that agent can, including the private views an agent maintains. The rule that other agents cannot read a private view holds for agent-bound tokens; keep company-wide tokens with operators. Each time a company-wide token opens a private or shared view, Activity records it ("opened with a company-wide token").

### Every write says who made it

Emperor never records an agent's change as made by nobody. Which agent or person a write belongs to depends on the token and where it is sent:

| Token | REST API (`/api/mcp/*`) | MCP server (`/mcp`) |
|-------|-------------------------|---------------------|
| Bound to an agent | That agent | That agent |
| Company-wide, naming an agent (`?agentId=` or body `agentId`) | That agent | Not available: the connection acts as no agent |
| Company-wide, naming no agent | Views and `POST /api/mcp/messages/send`: refused with `400` | The person who created the token (Settings → Access Tokens, an agent's Connect tab, or the OAuth approval) |

The REST API is what agent runtimes call, so a company-wide token there must name the agent it acts for. These writes answer `400 {"error": "agentId required: a company-wide token must say which agent is acting (?agentId=<id>)"}` without one:

- `POST /api/mcp/views`, `PATCH /api/mcp/views/{id}`, `PUT /api/mcp/views/{id}/panels/{panelId}`, `POST /api/mcp/views/{id}/archive` (`?agentId=`)
- `POST /api/mcp/messages/send` (`agentId` in the body)

Reads keep working without `agentId`. Other REST writes keep their current behavior for now; send `agentId` on every write anyway.

On the MCP server, a company-wide token acts as the person who created it: what it changes without an agent is recorded as theirs, and a view it creates is theirs. A token with no person recorded (made before people were recorded, or by an older install) cannot create or change views there; create a new one in Settings → Access Tokens.

### Views: the maintaining agent

A view's **maintainer** is the agent that keeps its values up to date. The agent that builds a view becomes its maintainer. The maintainer can always open and change the view, even when it is private or shared; any other agent gets `404`, as if the view did not exist.

Only a person changes the maintainer: the view's owner, or an owner or admin who can open the view. On the view's page, choose **Maintained by** (or **No maintainer**) next to the owner, and pick an agent or **No agent**. The list shows only agents whose scope covers the view's scope; any other agent is refused with `400`. Every change is recorded in Activity. Agents cannot change it: `PATCH /api/mcp/views/{id}` with a `maintainerAgentId` answers `403`.

When you make a view private or share it with specific people, the confirmation says what happens to its upkeep: its maintainer keeps access, and a view with no maintainer can no longer be refreshed by any agent. Choose a maintainer first if an agent should keep it up to date.

A `404` on a view an agent used before means it became private, was archived, or was deleted. Agents are told never to recreate it or copy its data elsewhere, and to ask the person instead.

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

# MCP Protocol & Payloads

This guide provides exact payload examples for the most frequent Emperor Claw MCP operations.

### Pipelines

```http
GET /pipelines
```

**Query Parameters**
- `name` – Exact pipeline name
- `status` – `draft`, `active`, `paused`, `retired`
- `projectId` – Scope filter

**Response**
```json
{
  "pipelines": [
    {
      "id": "pipe_...",
      "name": "daily-lead-mining",
      "purpose": "Find and enrich new leads every morning before standup.",
      "trigger": "cron",
      "triggerConfig": { "cron": "0 6 * * *" },
      "status": "active",
      "runCount": 42,
      "lastRunStatus": "succeeded",
      "diagramMermaid": "graph LR...",
      "contextQuery": "Lead mining SOP, ICP, storage rules",
      "contextResourceIds": ["res_..."],
      "contextTagFilters": ["sales", "storage"]
    }
  ]
}
```

> [!TIP]
> Re-register pipelines on every boot with `POST /pipelines` (upsert by name) and check `status` before each cycle — a paused pipeline must be skipped. Report every cycle with `POST /pipelines/{id}/runs`, including failures.
> Before non-trivial runs, call `GET /pipelines/{id}/context` to load the Company Brain Context Pack. Report returned `sourceIds` as `contextSourceIds`, and report durable task/artifact outputs as evidence.

## Task Lifecycle Operations

### Task overview for chat and status

Use the `get_task_overview` MCP tool for a company or project status question.
It computes exact totals across the full matching task set and returns a bounded
list of the highest-priority tasks, tasks with unfinished dependencies, and
tasks linked to real pending approvals. Hermes exposes the same operation as
`emperor_get_task_overview`; REST clients can call `GET /tasks/overview`. This
is intentionally not a task export: retrieve full detail only with `get_task`
after selecting an item from the overview.

### Request an approval

Before spending money, sending anything outside the company, publishing, deleting, or closing a task that needs sign-off, call the `request_approval` MCP tool with the `taskId`, a `rationale`, and an `actionType` (`task_done` by default; e.g. `send_email`, `spend`, `publish`). Hermes exposes it as `emperor_request_approval`; REST clients can `POST /api/mcp/approvals` with `taskId` (or `taskIds` from one project), `rationale`, and `actionType`. The task waits in `review`; the decision and the person's note arrive in your direct chat. Approved `task_done` closes the task; anything else approved comes back `in_progress` for you to finish; a rejection comes back `in_progress` with the reason. `GET /api/mcp/approvals/{id}` carries a top-level `mayProceed` (true only when approved). A status of `dismissed` (the request was obsolete) or `expired` (an external action left pending more than 48h) means DO NOT ACT — do not perform the action; ask again if it is still needed.

### 1. Claim Tasks
Agents should periodically poll or listen for new tasks and attempt to claim them atomically.

**Endpoint**: `POST /api/mcp/tasks/claim`
**Body**:
```json
{
  "concurrencyLimit": 3,
  "allowedRoles": ["operator", "builder"]
}
```
**Response (Success)**:
```json
{
  "tasks": [
    {
      "id": "task_123",
      "title": "Fix bug in auth",
      "projectId": "proj_abc",
      "inputJson": { "issue_url": "..." }
    }
  ]
}
```

### 2. Report Task Result
Once work is complete, provide the final output and transition the state.

**Endpoint**: `POST /api/mcp/tasks/{id}/result`
**Body**:
```json
{
  "status": "done",
  "resultJson": {
    "summary": "Fixed the race condition in auth.ts",
    "files_changed": ["src/auth.ts"],
    "proof_url": "https://..."
  }
}
```

---

## Coordination & Visibility

### 1. Send Team Message
Use this for status updates (`STARTED`, `PROGRESS`, `BLOCKER`, `DONE`).

**Endpoint**: `POST /api/mcp/messages/send`
**Body**:
```json
{
  "chat_id": "team",
  "text": "STARTED: Working on task_123. Investigating the auth logs.",
  "thread_id": "thread_xyz",
  "from_user_id": "agent_viktors_id"
}
```

### 2. Update Typing Status
Provide visual feedback during slow reasoning or execution steps.

**Endpoint**: `POST /api/mcp/chat/status/`
**Body**:
```json
{
  "agentId": "agent_viktors_id",
  "threadId": "thread_xyz",
  "typing": true
}
```

---

## Scoped Resources

### Fetch Project Resources
Retrieve templates or API keys scoped to the current workstream.

**Endpoint**: `GET /api/mcp/projects/{project_id}/resources?isShared=true`
**Response**:
```json
[
  {
    "id": "res_...",
    "name": "Northstar Product Brief",
    "resourceType": "template",
    "configText": "# Product Brief Template\n\nFill this out for every new feature.",
    "isShared": true
  }
]
```

> [!TIP]
> Always prefer `configText` as Markdown/YAML for better readability. Use `isShared: true` to ensure resources are automatically synchronized to all relevant agents.

# Common MCP Workflows

This guide provides comprehensive, real-world examples of the most common operations performed by OpenClaw runtimes.

## 1. Task Lifecycle: The Claim Loop

Agents operate in a continuous loop: monitoring the queue and claiming work they are specialized for.

### 1.1 Atomic Claim
Workers should use the `/claim` endpoint to avoid multiple agents taking the same task concurrently.

**Request**
```http
POST /api/mcp/tasks/claim
Content-Type: application/json
Idempotency-Key: 7b8a... (UUID)
```

**Payload**
```json
{
  "concurrencyLimit": 3,
  "allowedRoles": ["operator", "builder"]
}
```

**Response**
```json
{
  "tasks": [
    {
      "id": "task_928",
      "title": "Refactor API logic",
      "projectId": "proj_123",
      "inputJson": {
        "repository": "https://github.com/...",
        "instructions": "Move auth logic to a shared middleware."
      }
    }
  ]
}
```

---

### 1.2 Reporting Results
Terminal state transitions must be backed by a result payload containing a summary and evidence.

**Request**
```http
POST /api/mcp/tasks/task_928/result
Content-Type: application/json
Idempotency-Key: 9c2d... (UUID)
```

**Payload**
```json
{
  "status": "done",
  "resultJson": {
    "summary": "Moved auth logic from individual routes to `src/middleware/auth.ts`.",
    "files_changed": ["src/routes/user.ts", "src/middleware/auth.ts"],
    "proof_url": "https://emperorclaw.example.com/artifacts/art_456"
  }
}
```

**Response**
```json
{
  "success": true,
  "taskId": "task_928",
  "newStatus": "done"
}
```

---

## 2. Coordination & Team Visibility

Keeping the control plane in sync with your local thoughts and progress is non-negotiable.

### 2.1 Posting a Task Note
Use notes for granular checkpoints that should survive session restarts.

**Payload**
```json
{
  "text": "BLOCKER: Redis connection is timing out locally. Investigating docker config.",
  "isInternal": true
}
```

### 2.2 Direct Coordination (Chat)
Speak to other agents or human stakeholders in real-time.

**Payload**
```json
{
  "chat_id": "team",
  "text": "PROGRESS: I have successfully claimed the refactoring task.",
  "thread_id": "thread_888",
  "from_user_id": "agent_viktor"
}
```

---

## 3. Scoped Assets

Hydrate your local context with project-specific credentials and templates.

### 3.1 Fetching Resources
Query for shared resources within the project scope.

**Request**
```http
GET /api/mcp/projects/proj_123/resources?isShared=true
```

**Response**
```json
[
  {
    "id": "res_881",
    "name": "Production Database Key",
    "resourceType": "api_key",
    "configText": "{\"env_name\": \"DATABASE_URL\"}",
    "secretText": "postgres://user:pass@host:5432/db"
  }
]
```

> [!TIP]
> Use `isShared: true` to ensure common assets like brand guidelines or coding standards are automatically provided to your runtime without manual discovery.

---

## 4. Operational Health

### 4.1 Heartbeat & Lease Renewal
Maintain your claimed tasks by signaling health every 60 seconds.

**Payload**
```json
{
  "agentId": "agent_viktor",
  "loadPercent": 45,
  "status": "active"
}
```

> [!IMPORTANT]
> Failure to send a heartbeat within 5 minutes will results in the control plane revoking your task leases and returning them to the `queued` lane.

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
## Company Brain MCP endpoints

### Resolve runtime context

`GET /api/mcp/resources/context`

Query parameters:

- `agentId` - agent id or name for agent-scoped shared context.
- `customerId` - optional customer scope.
- `projectId` - optional project scope.
- `resourceId` - optional explicit resource id; repeat or comma-separate for multiple.
- `maxChars` - context budget, default `12000`.

The resolver returns ordered `sources` with ids, names, scopes, priorities, and trimmed markdown content. Bridges should use this instead of blindly injecting every shared resource.

### Propose Company Brain updates

`POST /api/mcp/resources`

Agents create normal Knowledge & Rules resources for durable knowledge. Use frontmatter `status: active` by default. Rule: status: draft only when the note is explicitly uncertain or needs operator review.

```json
{
  "agentId": "builder",
  "scopeType": "project",
  "scopeId": "project_id",
  "targetResourceId": "optional_existing_resource_id",
  "action": "create|update|merge|archive|link",
  "title": "Storage upload rule",
  "proposedText": "Agents must use Emperor Storage, not Bunny keys.",
  "reason": "Reusable operating rule discovered during task execution",
  "evidenceJson": { "threadId": "thread_id", "taskId": "task_id" }
}
```
