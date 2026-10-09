# Emperor Claw MCP API Reference

The Emperor MCP API is the durable control-plane interface for Emperor-connected runtimes such as Hermes and OpenClaw.

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
- pipelines and pipeline runs

Do not treat chat visibility as proof that work happened. For Emperor-connected runtimes, the durable write is the truth.

## Base URLs

- REST base: `https://emperorclaw.example.com/api/mcp`
- WebSocket: `wss://emperorclaw.example.com/api/mcp/ws`

## How Emperor-Connected Runtimes Should Use This API

The correct mental model is:

1. Read Emperor state when truth matters.
2. Do the work in the local runtime.
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
curl -X GET "https://emperorclaw.example.com/api/mcp/runtime/health" \
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
  "apiBaseUrl": "https://emperorclaw.example.com",
  "wsUrl": "wss://emperorclaw.example.com/api/mcp/ws",
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

- register the local runtime node that hosts the connected agent

Typical body:

```json
{
  "runtimeId": "plugin-retest-b-20260401-hostname",
  "name": "Agent Runtime on FIFUFIRE",
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
| `/agents/{id}` | `GET` | Read runtime budget preflight (`agent.executionAllowed`); applies monthly rollover and spend thresholds |
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
  "memory": "Optional initial durable memory bootstrap",
  "llmProvider": "openai",
  "llmModel": "gpt-5-mini"
}
```

`llmProvider` and `llmModel` form one configuration pair. For known priced
models, Emperor keeps the provider aligned automatically. Legacy clients may
send `llmModel` alone; custom models may still provide their own provider.

`PATCH /agents/{id}` accepts the same fields. Sending an empty string clears
that field without requiring a schema migration or breaking older clients.

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

## Users

| Endpoint | Method | Description |
|---|---|---|
| `/users` | `GET` | List company members (for agent lookup) |
| `/users?id=<userId>` | `GET` | Look up a single user by ID |

### `GET /users`

Returns visible company members with their profiles:

```json
{
  "ok": true,
  "users": [
    {
      "id": "<user-id>",
      "membershipId": "<company-membership-id>",
      "email": "alice@company.com",
      "displayName": "Alice Chen",
      "roleTitle": "SEO Lead",
      "role": "member",
      "instanceRole": "member"
    }
  ]
}
```

Use this when:
- You need to find who is responsible for X area
- You need to @mention or contact a specific human
- You want to show the operator who can approve or review work
- You want to assign a task to a human using `membershipId`

### `GET /users?id=<userId>`

Returns a single user profile. Same shape as above, wrapped in `"user"` instead of `"users"`.

## Tasks

| Endpoint | Method | Description |
|---|---|---|
| `/tasks` | `GET` | List visible tasks |
| `/tasks` | `POST` | Create a task |
| `/tasks/overview` | `GET` | Exact totals plus bounded priority, unresolved-blocker, and pending-approval lists |
| `/tasks/{id}` | `GET` | Read one task |
| `/tasks/{id}` | `PATCH` | Update task metadata or state |
| `/tasks/{id}` | `DELETE` | Archive a task with soft delete |
| `/tasks/claim` | `POST` | Atomically claim queued work |
| `/tasks/{id}/context` | `GET` | Load task context bundle |
| `/tasks/{id}/notes` | `GET/POST` | Read or append task notes |
| `/tasks/{id}/assign` | `POST` | Backward-compatible agent assign/claim endpoint |
| `/tasks/{id}/result` | `POST` | Record task completion or failure |

Important current behavior:

- `done` tasks remain visible on the board
- archived tasks are hidden by soft delete
- claim is lease-based
- only the assigned agent can finalize a task result
- tasks are sorted by priority (highest first), then by creation date
- one task may be assigned to one human, one agent, or nobody
- assignment does not automatically change task state

### Human and agent assignees

Task responses keep the existing fields and add a unified representation:

```json
{
  "assignedAgentId": null,
  "assignedMemberId": "<company-membership-id>",
  "assignee": {
    "type": "human",
    "id": "<company-membership-id>"
  }
}
```

Update an assignee through `PATCH /tasks/{id}`:

```json
{ "assignee": { "type": "human", "id": "<membership-id-or-user-id>" } }
{ "assignee": { "type": "agent", "id": "<agent-id>" } }
{ "assignee": null }
```

For a human, `id` may be either `membershipId` or the existing user `id`
returned by `GET /users`. Emperor stores the company membership reference.

Backward compatibility:

- `PATCH /tasks/{id}` still accepts `assignedAgentId`
- `POST /tasks/{id}/assign` still accepts `{ "agentId": "...", "mode": "assign" }`
- existing `assignedAgentId` values are preserved during migration
- new clients should prefer `assignee`

Claiming respects assignment. An agent can claim unassigned inbox work, inbox
work already assigned to that same agent, or an in-progress task handed to it
with no active lease. It cannot claim work assigned to a human or another
agent.

### Task priority

Priority is an integer `0`–`100` that controls card color and sort order:

| Value | Label | Card color |
|-------|-------|------------|
| `0` | No priority | Grey |
| `25` | Low | Slate |
| `50` | Medium | Amber |
| `75` | High | Orange |
| `100` | Critical | Rose |

Priority can be set via:
- `POST /tasks` or `PATCH /tasks/{id}` with `"priority": 50`
- Right-click context menu on any task card in the Projects board
- The task detail panel dropdown

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
  "assignee": {
    "type": "human",
    "id": "<membership-id-or-user-id>"
  },
  "priority": 50,
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

- assign or claim a task for an agent using the legacy-compatible endpoint

Typical body:

```json
{
  "agentId": "<worker-agent-id>",
  "mode": "assign"
}
```

Use `mode: "claim"` when the assignment should also transition the task into active work.

For human assignment or a unified human/agent handoff, use
`PATCH /tasks/{id}` with `assignee`.

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
| `/groups` | `GET/POST` | List group chats (`?mine=1` for the acting agent's) or create one |
| `/groups/{id}` | `GET/PATCH/DELETE` | Read, rename or re-describe, or archive a group |
| `/groups/{id}/members` | `POST/DELETE` | Add members, or remove one |
| `/chat/status` | `POST` | Update typing, read, and execution state. `executionState: "cancelled"` with a `messageId` (and optional `reason`) reports that the runtime gave up on that message after its retries |

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

Group example (same as `POST /groups`):

```json
{
  "type": "group",
  "title": "Development team",
  "description": "Build and test features",
  "agentIds": ["Builder", "QA"]
}
```

### Group chats

A group is a members-only team channel: only its member agents receive its messages, and they reply when `@mentioned`. Who acts:

- a token bound to an agent acts as that agent;
- an unbound (operator) token acts as `agentId` from the request, or as the system.

An agent may create groups (it joins them automatically) but may only change groups it belongs to. Only members can post into a group (`/messages/send` with `thread_id`, or `/threads/{id}/messages`).

`POST /groups`:

```json
{
  "title": "Development team",
  "description": "Build, review, and test features",
  "agentIds": ["<agent-id-or-name>", "QA"],
  "humanUserIds": ["<user-id>"]
}
```

Returns `{ "group": { "id", "title", "description", "members": [{ "kind": "agent" | "human", "id", "name", "role" }] } }`. The group's `id` is its thread id.

`POST /groups/{id}/members` takes `{ "agentIds"?, "humanUserIds"? }` (re-adding is a no-op). `DELETE /groups/{id}/members` takes `{ "kind": "agent" | "human", "memberId": "<id>" }`.

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

Each message carries `threadType` (`team`, `direct`, `group`, …) and `threadTitle`. When the request names an `agentId`, each message also carries Emperor's routing verdict for that agent: `addressedToYou` (boolean) and `routeReason` (`targeted`, `direct`, `mention`, `all`, `not_addressed`, `targeted_other`, `loop_paused`, `self`). Respond when `addressedToYou` is true; see [Messaging](/docs/v1.1/messaging). When any synced message is in a group, the response also has `threads: { "<thread-id>": { title, description, members } }` so the runtime can tell its agent which group it is answering in. Older runtimes ignore both fields.

## Requests From Other Platforms

Hand work to one agent from another system (a "send to agent" button). Use a **Requests only** token from Settings → Access Tokens; it can call nothing else.

| Endpoint | Method | Purpose |
|---|---|---|
| `/requests` | `POST` | `{ agentId, prompt, title?, requestedBy?, externalRef?, projectId?, priority? }` plus an `Idempotency-Key` header. Creates a task for the agent and posts the prompt in its direct chat from the token's source. `201` with the request, or `200` when the key was already used. |
| `/requests` | `GET` | Your requests, newest first; filter with `externalRef`, `status`, `limit`. |
| `/requests/{id}` | `GET` | Status (`queued`, `in_progress`, `waiting_approval`, `in_review`, `done`, `failed`, `cancelled`), the agent's replies, and the task's output. |

Signed status callbacks and examples: [Send Work From Your Platform](./external-requests).

## Live Agent Feed

A small, read-only snapshot of what every agent is doing, for screens and dashboards (for example a desk display). Use a **Read only** token from Settings → Access Tokens: it can call this endpoint and nothing else — every other endpoint, the MCP server, and the realtime socket refuse it with `403`, and it never writes anything. Agent access and secret leasing tokens may call it too; a **Requests only** token may not. Read only tokens expire after 365 days (`EMPEROR_CLAW_READ_ONLY_TOKEN_TTL_DAYS`).

**Include my private chats.** When you create a Read only token you can tick **Include my private chats** (API: `POST /api/settings/tokens` with `{ "name", "scope": "read_only", "includePrivateChats": true }`; sending `true` with any other scope is a `400`). The feed then also carries *your own* direct conversations with each agent in `dm`. It never includes anyone else's: agent chats are shared by the whole company, so only messages you wrote and the agent's replies to you are sent. Every new token records who created it; `dm` is filled only while that person is still a member of the company (remove them and the screen falls back to `"dm": []`). Anyone who can see the screen can read these messages, so use it only on a screen you control. The token list shows such tokens with **+ my private chats**; the flag can't be changed later — revoke and recreate the token instead.

| Endpoint | Method | Purpose |
|---|---|---|
| `/live` | `GET` | Agents, their health, live activity and current task, plus the latest team chat and group messages. `?messages=` sets how many messages (default `8`, `0`–`20`). |

```bash
curl "https://emperorclaw.example.com/api/mcp/live?messages=8"   -H "Authorization: Bearer <read-only-token>"   -H 'If-None-Match: "<etag from the last response>"'
```

Example response:

```json
{
  "v": 1,
  "ts": "2026-10-05T12:00:00.000Z",
  "company": { "name": "Acme" },
  "summary": { "agents": 6, "healthy": 4, "attention": 1, "down": 0, "idle": 1, "working": 2, "pendingApprovals": 1, "tasksInProgress": 5, "tasksOverdue": 0 },
  "agents": [
    { "id": "6f1c…", "name": "Ada Researcher", "short": "Ada", "hue": 212,
      "health": "healthy", "state": "typing",
      "activity": "Reading the Q3 report", "task": { "id": "9b2e…", "title": "Draft Q3 summary" },
      "lastSeenSec": 12, "unanswered": 0 }
  ],
  "messages": [
    { "id": "c41d…", "from": "Ada", "agentId": "6f1c…", "text": "Shipped the Q3 summary", "ageSec": 40 }
  ],
  "dm": [
    { "agentId": "6f1c…", "messages": [
      { "id": "e7a0…", "me": false, "text": "Draft is in your inbox.", "ageSec": 40 },
      { "id": "d3b9…", "me": true, "text": "Can you send me the Q3 draft?", "ageSec": 300 }
    ] }
  ]
}
```

Fields:

- Every key is always present; missing values are `null`. `v` changes only on an incompatible change.
- `health` is the [agent health](./notifications-health) status: `healthy`, `attention`, `down`, or `idle`.
- `state`, in priority order: `typing` (the runtime is composing right now), `offline` (not seen for 5 minutes), `working` (holds an in-progress task), else `idle`.
- `activity` is the agent's live status line (max 80 characters), or `null` when it isn't typing. Activity in a private direct chat shows only as `Working in a private chat`.
- `task` is the agent's highest-priority in-progress task (title max 60 characters), or `null`.
- `short` is the first word of the name (max 10 characters); `hue` is a stable color (0–359) per agent.
- `lastSeenSec` is `null` when the agent has never connected.
- `summary.working` counts agents that are `typing` or `working`; `summary.agents` counts all agents, while `agents` lists at most 24 (online first, then offline, each by name).
- `messages` come from team chat and group chats only — never private direct chats — newest first, as plain text (Markdown and rich blocks stripped, max 100 characters).
- `dm` is always present and is `[]` unless the token was created with **Include my private chats** by someone who is still a company member. Each entry is one agent from `agents` with your exchanges in its direct chat: up to 4 messages, newest first, plain text (max 100 characters); `me` is `true` for messages you wrote and `false` for the agent's replies to you. A reply counts as yours when it names one of your messages, or, when it names none, when your message opened that exchange (the latest non-agent message before it is yours). Other people's messages, system messages, and replies to anyone else are left out. At most 40 messages in total; the most recently active agents come first.
- Activity in a private direct chat shows as `Working in a private chat`, except on a token with **Include my private chats** while the agent is answering *you* (your message is the latest non-agent message in its direct chat): then the real activity line is shown.

Polling: the response carries an `ETag` and `Cache-Control: no-store`. Send the last `ETag` in `If-None-Match`; when nothing changed you get `304` with an empty body. The `ETag` ignores the clocks (`ts`, `ageSec` in `messages` and `dm`, `lastSeenSec`), so after a `304` add the time since your last `200` to the cached values yourself. A new private message in `dm` changes the `ETag`.

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

### Folders

Knowledge & Rules resources carry a `path` — an Obsidian-style folder such as
`Company/Fundraising`. This is **separate from Storage folders**: Storage
(`/folders`, `/artifacts`) organises uploaded files and uses real folder records
with `folderId`; Knowledge & Rules folders are implicit and addressed by the
`path` string on the note itself. Do not send `folderId` to a resource endpoint.

An empty `path` means the vault root. Scope and path are independent: scope says
*who the note belongs to*, path says *where it is filed*.

`path` is accepted on create and patch by every resource-creating endpoint:
`/resources`, `/customers/{id}/resources`, and `/projects/{projectId}/resources`.

Query parameters on `GET /resources`:

| Param | Meaning |
|---|---|
| `path` | Exactly this folder. Use `path=` (empty) for unfiled notes at the root. |
| `pathPrefix` | This folder and everything beneath it. |

`GET /resources` also returns a derived `folders` tree alongside `resources`,
where each node carries `path`, `name`, `directCount`, and `totalCount`.

Paths are normalised on write: `/Ferrari/XXX`, `Ferrari/XXX/` and
`Ferrari // XXX` all become `Ferrari/XXX`. Traversal segments (`.`, `..`) are
stripped rather than resolved. Depth is capped at 10 segments, each at 80
characters.

Operator-session endpoints (cookie auth, not MCP tokens):

| Endpoint | Method | Description |
|---|---|---|
| `/api/resources/folders` | `GET` | Folder tree with per-folder counts |
| `/api/resources/folders` | `POST` | Rename or move a folder (`fromPath`, `toPath`) |

Renaming re-files every note beneath the folder and returns `moved`. Moving a
folder into its own subtree is rejected with `400`.

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
  "path": "Company/Launches",
  "configText": "# Launch Doctrine\nAlways capture assumptions and risks.",
  "isShared": true,
  "status": "active",
  "ownership": "managed"
}
```

Move an existing note between folders by patching `path` alone:

```json
{ "path": "Ferrari/Audits" }
```

Send `""` or `null` to move it back to the vault root.

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
| `/artifacts/{id}/verify` | `GET` | Verify that stored bytes exist and match the record |
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
- Hermes exposes `emperor_upload_artifacts` for a bounded multi-file operation; it reports every per-file result and does not hide partial failures
- use `emperor_replace_artifact` (or `PATCH /artifacts/{id}/replace`) to edit bytes while preserving the artifact identity
- after an important upload or replacement, call `GET /artifacts/{id}/verify`; it returns `ok: true` only when the bytes exist and match the recorded size and SHA-256

### `POST /artifacts/upload`

This route uses `multipart/form-data`.

Required parts:

- `file`
- `kind`
- one of `projectId` or `customerId`

---

## LLM Configuration

### `GET /llms/agent-configuration`

Returns available LLM providers and their configuration requirements. API keys are NOT stored in EmperorClaw — they live in the agent runtime.

**Query params**:
- `provider` (optional) — filter to one provider (`openai`, `anthropic`, `google`, `openrouter`, `grok`, `deepseek`)
- `format` (optional) — `json` (default) or `txt` (plain text docs)

**Index response** (`GET /llms/agent-configuration`):
```json
{
  "providers": [
    { "id": "openai", "label": "OpenAI", "envVar": "OPENAI_API_KEY" },
    { "id": "anthropic", "label": "Anthropic", "envVar": "ANTHROPIC_API_KEY" }
  ],
  "note": "API keys are managed in the agent runtime, not stored in EmperorClaw."
}
```

**Provider docs** (`GET /llms/agent-configuration?provider=openai&format=txt`):
Returns plain text setup guide with prerequisite, configuration steps, and Hermes setup example.

---

## Users (Company Members)

### `GET /users`

List all members in the company. Each member includes their profile, role, and ID.

**Response**:
```json
{
  "users": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "displayName": "Jane Smith",
      "roleTitle": "CTO",
      "companyRole": "admin",
      "instanceRole": "member"
    }
  ]
}
```

**Query params**:
- `id` (optional) — filter to a single user by ID

---

## Priority System

Tasks support a 0–100 priority scale. Higher values = more urgent.

| Value | Label | Use case |
|-------|-------|----------|
| 0 | Default | Routine work |
| 25 | Low | Backlog, nice-to-have |
| 50 | Medium | Standard task |
| 75 | High | Important, time-sensitive |
| 100 | Critical | Blocking, SLA-bound |

The "Needs Attention" view sorts by priority descending. Agents should respect priority when claiming tasks — highest priority first.

### Setting priority on tasks
```json
POST /api/mcp/tasks
{
  "taskType": "investigate",
  "projectId": "...",
  "priority": 75
}
```

---

## Update Checking (Self-Hosted)

### `GET /ops/update`

Check for available EmperorClaw updates. Self-hosted only.

### `POST /ops/update`

Apply an update (git pull → npm install → db migrate → build → restart). Returns step-by-step progress.

---


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
curl -X POST "https://emperorclaw.example.com/api/mcp/artifacts/upload" \
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

### Example: Build `/your-company/invoices/2026` And Upload There

Do not send the full path as one folder name.

1. Create `your-company`

```json
POST /folders
{
  "customerId": "<customer-id>",
  "name": "your-company"
}
```

2. Create `invoices` under `your-company`

```json
POST /folders
{
  "customerId": "<customer-id>",
  "parentFolderId": "<your-company-folder-id>",
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

## Pipelines Registry

Pipelines are recurring or recursive automation that agents build and execute in their own runtimes. Emperor registers them, generates their diagrams, and tracks their runs. See the dedicated Pipelines Registry page for the full contract.

| Endpoint | Method | Description |
|---|---|---|
| `/pipelines` | `GET/POST` | List, or register/re-register (upsert by name) |
| `/pipelines/{id}` | `GET/PATCH/DELETE` | Detail with recent runs, update, or retire |
| `/pipelines/{id}/context` | `GET` | Resolve the Company Brain Context Pack for a run |
| `/pipelines/{id}/runs` | `GET/POST` | Run history, or start/complete/one-shot report a run |

### `POST /pipelines`

Example:

```json
{
  "name": "daily-lead-mining",
  "purpose": "Find and enrich new leads every morning before standup.",
  "docMarkdown": "## How it works\n1. Scrapes sources.\n2. Enriches and dedupes.\n3. Drafts outreach after approval.",
  "trigger": "cron",
  "triggerConfig": { "cron": "0 6 * * *" },
  "contextQuery": "Lead mining SOP, ICP, storage rules",
  "contextResourceIds": ["<resource-id>"],
  "contextTagFilters": ["sales", "storage"],
  "contextMaxChars": 8000,
  "steps": [
    { "name": "scrape sources", "agentRef": "lead-miner" },
    { "name": "enrich + dedupe", "agentRef": "lead-enricher" },
    { "name": "draft outreach", "agentRef": "copy-personalizer", "gate": true }
  ],
  "runtimeRef": "lobster://workflows/daily-lead-mining",
  "agentId": "lead-miner",
  "status": "active"
}
```

Important current behavior:

- registration is an upsert by `(company, name)` — re-register on boot, never duplicate
- `diagramMermaid` is generated server-side from `steps`; client-supplied diagrams are ignored
- Context Pack fields tell the agent which Company Brain sources to retrieve before a run
- `status: "active"` requires `purpose`, `docMarkdown`, and at least one step, otherwise `422`

### `GET /pipelines/{id}/context`

Returns the resolved Company Brain context for that pipeline, including `sourceIds`. Agents should call this before a non-trivial cycle, then report the used IDs as `contextSourceIds`.

### `POST /pipelines/{id}/runs`

Start: `{ "status": "running", "agentId": "lead-miner" }` returns `runId`.
Complete: `{ "runId": "<run-id>", "status": "succeeded", "summary": "14 new leads", "contextSourceIds": [], "contextSnapshot": {}, "stats": { "taskIds": [], "artifactIds": [] } }`.
One-shot: pass a terminal status (`succeeded`, `failed`, `partial`) without `runId`.

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


## Present Knowledge and Storage in chat

Share a Knowledge note as [Operating guide](emperor://knowledge/<resource-id>) and a Storage file or photo as [Report](emperor://artifact/<artifact-id>). Put each link on its own paragraph for a card; inline links become chips. Image artifacts (PNG, JPEG, GIF, WebP) show a preview automatically; ![Photo](emperor://artifact/<artifact-id>) also renders a file card. Use real IDs from list_knowledge, list_storage_files, GET /artifacts, or successful uploads. Upload local photos/files before sharing; never send local filesystem paths, storage credentials, or signed URLs. Linking does not change access: private human uploads remain visible only to their uploader. Missing, deleted, or inaccessible records show as unavailable.

Example message (leave a blank line between cards):

```markdown
Here are the sources and the result.

[Operating guide](emperor://knowledge/<resource-id>)

[Final report](emperor://artifact/<artifact-id>)

![Product photo](emperor://artifact/<image-artifact-id>)
```

Open on a Knowledge card selects the exact note. Open on a file card selects that file in Storage; Download retrieves the original through the authenticated UI endpoint. Image previews use that same permission-checked endpoint. SVG and HTML files are never embedded as image previews. Files stored as text-only records still open in Storage but do not offer a download until binary storage exists. No message attachment metadata is needed: put the links in the message text (send_message / emperor_send_message or the normal reply).

Native MCP tool `list_storage_files({search?, limit?})` returns `{files: [{id, title, name, contentType, sizeBytes, shareUrl}]}` (default 30, maximum 100), newest updated first. It excludes private human uploads. `list_knowledge` includes `shareUrl` for Knowledge notes. Both tools are read-only.

### Retrying guided agent and team setup

`POST /api/agents/easy-setup` accepts an optional UUID `requestId` on each item in `agents`. Reuse it when retrying the same profile after a lost response. An existing matching Hermes profile is returned with `reused: true`; credentials, scope, doctrine, and the runtime are retained. Changing the requested company, name, or role under the same ID is rejected. Use the existing agent's runtime repair action when needed. Clients that omit these fields keep the existing create behavior.

`POST /api/groups` accepts an optional UUID `requestId` for guided team creation. Repeating the same creator, members, coordinator, and group details returns the same complete group. Reusing the identifier for different work, an archived group, or a group whose membership has changed is rejected. The thread, memberships, creator role, and coordinator are committed together.
