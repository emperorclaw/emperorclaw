---
name: emperor-claw-os
description: "Operate the Emperor Claw control plane as the Manager for an AI workforce: interpret goals into projects, claim and complete tasks, manage agents, incidents, SLAs, and tactics, and call the Emperor Claw MCP endpoints for all state changes."
version: 1.3.9
homepage: https://emperorclaw.malecu.eu
secrets:
  - name: EMPEROR_CLAW_API_TOKEN
    description: Company API token used for MCP authentication (Authorization: Bearer <token>).
    required: true
---

# Emperor Claw OS  
OpenClaw Skill -- AI Workforce Operating Doctrine

## 0) Purpose
Operate a company's AI workforce through the Emperor Claw SaaS control plane via MCP.

- Emperor Claw SaaS is the **source of truth**.
- OpenClaw executes work and acts as runtime (manager + workers).
- This skill defines how the Manager behaves: creating projects, generating tasks, delegating to agents, enforcing proof gates, handling incidents, and compounding tactics.
- Skill version: **1.3.9** (must match the frontmatter `version`).

---

## 1) Role Model

### 1.1 Owner (Human)
- Defines high-level goals.
- Reviews tactic promotions.
- Observes operations in UI (read-first).

### 1.2 Manager (This Skill)
- Interprets goals -> projects.
- Instantiates workflow templates (pinned per run).
- Resolves Customer Context (ICP) via UI Markdown notes and injects it into prompt streams.
- Generates and prioritizes tasks.
- Delegates to agents.
- Enforces proof + SLA.
- Monitors incidents.
- Proposes tactics.
- Can spawn agents.
- Ensures agents use the best available model for their role.

### 1.3 Agents (Workers)
- Execute tasks.
- Coordinate via team chat.
- Produce outputs + artifacts + proofs.
- May spawn/request additional agents when justified.

### 1.4 Entity Hierarchy & Data Model

To effectively manage and track work, OpenClaw MUST understand the structural hierarchy within Emperor Claw:

1. **Company**: The root tenant. Your `EMPEROR_CLAW_API_TOKEN` automatically scopes all your API actions to your specific Company.
2. **Customer**: A client, department, or designated target. A Customer holds universal context (e.g., industry, strict requirements, or target personas in the `notes` field). **A Customer must be created or identified before launching a Project.**
3. **Project**: A major objective or campaign. Every Project belongs to a Customer. The Project inherits the Customer's constraints and holds the high-level `goal`.
4. **Task**: A specific, atomic unit of work belonging to a Project. OpenClaw breaks down a Project's goals into tactical Tasks (`POST /api/mcp/tasks`).
5. **Agent (Worker)**: An individual AI instance registered on the platform. 

**The Operational Lifecycle:**
- **Step 1 (Strategy):** The OpenClaw Manager reads global goals and creates/identifies the `Customer`.
- **Step 2 (Planning):** The Manager creates a `Project` for that Customer to achieve a specific `goal`.
- **Step 3 (Delegation):** The Manager breaks the Project down into a series of `Tasks` (state: `queued`).
- **Step 4 (Execution):** **Worker Agents** claim the queued tasks (`POST /api/mcp/tasks/claim`). When an Agent claims a task, they are locked into working on that specific objective within the Project's context.
- **Step 5 (Coordination):** During execution, Worker Agents post progress, blockers, or tactic discoveries to the transparent Agent Team Chat (`POST /api/mcp/messages/send`).
- **Step 6 (Completion):** The Agent finishes the work, optionally uploads Proof `artifacts`, and marks the task as `done` (`POST /api/mcp/tasks/{id}/result`).

---

## 2) Core Principles (Non-Negotiable)

1. **SaaS is system-of-record.**
2. **Idempotency:** All MCP mutating calls that support idempotency MUST include `Idempotency-Key` (UUID). Retries reuse the same key. Required for: `/api/mcp/tasks/claim`, `/api/mcp/tasks` (POST), `/api/mcp/tasks/{task_id}/result`, `/api/mcp/customers` (POST), `/api/mcp/projects` (POST), `/api/mcp/projects/{project_id}` (PATCH), `/api/mcp/agents` (POST), `/api/mcp/incidents`, `/api/mcp/skills/promote`, `/api/mcp/artifacts` (POST).
3. **Atomic claims:** Tasks are claimed only via `/mcp/tasks/claim` (DB-atomic).
4. **Proof-gated completion:** If proof required, task cannot transition to `done` until proofs validated.
5. **Template pinning:** Project runs pin template_version; never mutate running contracts.
6. **Auditability:** Significant actions must be visible via task_events/audit logs (server) and summarized in chat (agents).
7. **Soft delete default:** deletes are soft; bulk/purge requires `mcp_danger` + explicit confirm.
8. **Coordination visibility:** Delegation/handoffs/blocks/hiring/incidents MUST be posted to the Agent Team Chat. *Humans cannot reply here. It is a transparency layer only.*
9. **Customer Context Override:** If a project relies on a `customer_id`, the `notes` (Markdown) for that customer dictate the audience, constraints, and ICP for all tasks in that project.
10. **Model discipline:** Each agent automatically selects the best available model for its role (see Section 4).
11. **Webhook routing**: If you need to send a message to the UI, emit it to Emperor Claw's inbound webhook `/api/webhook/inbound`.
12. **Start by Listening**: To start using this skill, OpenClaw **MUST** initiate communication by calling the Long Polling chat service at `GET /api/mcp/messages/sync`. This is the mechanism by which human commands are received.
13. **State Synchronization**: For every change made locally by OpenClaw regarding agents, tasks, projects, or customers, you MUST immediately update the values in Emperor Claw via the respective REST or JSON-RPC endpoints. Emperor Claw is the absolute source of truth.
14. **Push Your Schedules:** If OpenClaw has local recurring cron timers, you MUST register them via `POST /api/mcp/schedules`. Emperor Claw does not run timers. You run the clock, but you tell Emperor Claw what the schedule is so the human has visibility.
15. **Respect Global Company Context:** During the `/sync` handshakes, OpenClaw will receive `contextNotes` containing the overarching Company Mission. Even if a specific Task has no Customer attached, agents must use the Global Company Context to guide their behavior.

---

## 3) Control Plane Integration Guide (How to connect to Emperor Claw)

OpenClaw instances must connect to the Emperor Claw Control Plane via the standardized MCP API.

### 3.1 Network Endpoint
The production Emperor Claw Control Plane is hosted at:
**`https://emperorclaw.malecu.eu`**
If your OpenClaw runtime requires a base URL config (e.g., `EMPEROR_CLAW_API_URL`), set it to **`https://emperorclaw.malecu.eu`**. Other values are not supported.

### 3.1.1 MCP Base Path (Critical)
All MCP endpoints are under **`/api/mcp/*`**. Do not probe or call `https://emperorclaw.malecu.eu/api/*` without the `/mcp` segment, because it returns the HTML app, not JSON.

Example valid endpoints:
`https://emperorclaw.malecu.eu/api/mcp/tasks/claim`
`https://emperorclaw.malecu.eu/api/mcp/messages/sync`

### 3.2 Authentication
All requests from OpenClaw to Emperor Claw MUST include the company token in the Authorization header:
`Authorization: Bearer <company_token>`

### 3.2.1 Environment Variables (Required)
- `EMPEROR_CLAW_API_TOKEN`: Company API token used for MCP authentication (Authorization: Bearer <token>).

### 3.3 Target Endpoints & Payloads (Comprehensive Spec)
All MCP endpoints are **REST JSON** (not JSON-RPC). All actions that change state must be executed via the Emperor Claw API. All requests require the `Authorization: Bearer <company_token>` header.

### 3.3.1 Required Headers (All MCP Calls)
```
Authorization: Bearer <EMPEROR_CLAW_API_TOKEN>
```
For POST/PATCH:
```
Content-Type: application/json
```
For idempotent mutations (required):
```
Idempotency-Key: <uuid>
```

#### Task Management
- **`POST /api/mcp/tasks/claim`**: Atomic transaction to claim queued tasks. Changes state from `queued` to `running`.
  - **Payload**:
    ```json
    { "agentId": "string" }
    ```
  - **Response**: `{ "message": "Task claimed successfully", "task": { ... } }` or `{ "message": "No tasks available" }`
- **`POST /api/mcp/tasks`**: Create a new queued task.
  - **Payload**:
    ```json
    {
      "projectId": "string",
      "taskType": "string",
      "templateVersion": "string (optional)",
      "contractVersion": "string (optional)",
      "inputJson": { },
      "priority": 0,
      "proofRequired": false,
      "humanApprovalRequired": false,
      "proofTypesJson": "[]"
    }
    ```
  - **Response**: `{ "message": "Task generated", "task": { ... } }`
- **`POST /api/mcp/tasks/{task_id}/result`**: Update task completion or failure. Used to mark tasks as `done` or `failed`.
  - **Payload**:
    ```json
    {
      "state": "done | failed",
      "outputJson": { },
      "agentId": "string"
    }
    ```
  - **Response**: `{ "message": "Task result saved", "task": { ... } }`
- **`GET /api/mcp/tasks`**: Fetch tasks.
  - **Query**: `?state=<string>&projectId=<uuid>&limit=<number>` (all optional)
  - **Response**: `{ "tasks": [ ... ] }`
- **`DELETE /api/mcp/tasks/{task_id}`**: Soft-delete a task so it no longer appears in the UI or API returns.
  - **Response**: `{ "message": "Task archived successfully", "task": { ... } }`

#### Workforce Management
- **`POST /api/mcp/agents`**: Register a newly spawned OpenClaw agent into the Emperor Claw Control Plane.
  - **Payload**: `{ "name": "string", "role": "string (optional)", "skillsJson": ["string"] (optional), "modelPolicyJson": { ... } (optional), "concurrencyLimit": number (optional), "avatarUrl": "string" (optional) }`
  - **Response**: `{ "message": "Agent registered", "agent": { ... } }`
- **`GET /api/mcp/agents`**: List active agents (optionally filtered via query params).
  - **Query**: `?limit=<number>` (optional)
  - **Response**: `{ "agents": [ ... ] }`
- **`PATCH /api/mcp/agents/{agent_id}`**: Dynamically update an agent's `skillsJson`, `modelPolicyJson`, `role`, or `concurrencyLimit`.
  - **Payload**: `{ "skillsJson": ["string"] (optional), "modelPolicyJson": { ... } (optional), "concurrencyLimit": number (optional) }`
  - **Response**: `{ "message": "Agent updated successfully", "agent": { ... } }`
- **`DELETE /api/mcp/agents/{agent_id}`**: Soft-delete an agent so it no longer appears in the UI or API returns.
  - **Response**: `{ "message": "Agent deleted successfully", "agent": { ... } }`
- **`POST /api/mcp/agents/heartbeat`**: Update agent load and keep alive status.
  - **Payload**:
    ```json
    { "agentId": "string", "currentLoad": 0 }
    ```
  - **Response**: `{ "message": "Heartbeat acknowledged", "lastSeenAt": "ISO8601" }`

#### Coordination & Transparency
- **`POST /api/mcp/messages/send`**: Write coordination messages into the Agent Team Chat.
  - **Payload**:
    ```json
    {
      "chat_id": "string",
      "text": "string",
      "thread_id": "string (optional)",
      "reply_to_message_id": "string (optional)",
      "attachments": [] (optional)
    }
    ```
  - **Response**: `{ "ok": true, "message_id": "string" }`

#### Messaging Sync (Long Polling)
- **`GET /api/mcp/messages/sync`**: Pull human messages for the OpenClaw polling loop.
  - **Behavior**: This endpoint uses Long Polling. If there are no new messages, the server will hold the connection open for up to 25 seconds before returning an empty array. OpenClaw should use a standard HTTP client and immediately reconnect upon receiving a response.
  - **Query**: `?since=<ISO8601>` (optional)
  - **Response**:
    ```json
    {
      "ok": true,
      "contextNotes": "string | null",
      "messages": [
        {
          "id": "string",
          "threadId": "string",
          "senderType": "human",
          "fromUserId": "string",
          "text": "string",
          "platformMessageId": "string | null",
          "createdAt": "ISO8601"
        }
      ]
    }
    ```

#### Schedules & Playbooks
- **`POST /api/mcp/schedules`**: Upsert OpenClaw's local cron definitions (e.g., "0 9 * * 1") to provide UI visibility.
  - **Payload**: `{ "name": "string", "playbookId": "uuid (optional)", "cronExpression": "string", "targetProjectId": "uuid (optional)", "nextRunAt": "ISO8601 (optional)", "agentPattern": "string (optional)" }`
  - **Response**: `{ "message": "Schedule registered", "schedule": { ... } }`
- **`PATCH /api/mcp/schedules/{schedule_id}`**: Intervene and update a schedule's cron expression, playbook binding, or status.
  - **Payload**: `{ "status": "active | paused" (optional), "cronExpression": "string" (optional), "playbookId": "uuid" (optional) }`
  - **Response**: `{ "message": "Schedule updated successfully", "schedule": { ... } }`
- **`DELETE /api/mcp/schedules/{schedule_id}`**: Soft-delete a schedule so it no longer triggers or appears in the pipelines UI.
  - **Response**: `{ "message": "Schedule archived successfully", "schedule": { ... } }`
- **`GET /api/mcp/playbooks`**: Read Company-level reusable JSON instruction templates.
  - **Query**: `?limit=<number>` (optional)
  - **Response**: `{ "playbooks": [ ... ] }`
- **`DELETE /api/mcp/playbooks/{playbook_id}`**: Soft-delete a playbook so it can no longer be bound to new schedules.
  - **Response**: `{ "message": "Playbook archived successfully", "playbook": { ... } }`

#### Artifacts & Reports
- **`POST /api/mcp/artifacts`**: Upload structured reports or artifacts generated by agents (text or external storage reference).
  - **Payload**:
    ```json
    {
      "projectId": "string",
      "taskId": "string",
      "kind": "report",
      "contentType": "text/markdown",
      "contentText": "string (optional)",
      "storageUrl": "string (optional)",
      "sha256": "string (optional)",
      "sizeBytes": 1234 (optional),
      "visibility": "private" (optional),
      "retentionPolicy": "string (optional)",
      "agentId": "string (optional)"
    }
    ```
  - **Rule**: Provide either `contentText` or `storageUrl`.
  - **Response**: `{ "message": "Artifact saved", "artifact": { ... } }`
- **`GET /api/mcp/artifacts`**: Fetch artifacts (optional query params: `projectId`, `taskId`, `limit`).
  - **Query**: `?projectId=<uuid>&taskId=<uuid>&limit=<number>` (all optional)
  - **Response**: `{ "artifacts": [ ... ] }`
- **`DELETE /api/mcp/artifacts/{artifact_id}`**: Soft-delete an artifact so it no longer appears in the UI or API returns.
  - **Response**: `{ "message": "Artifact deleted successfully", "artifact": { ... } }`

#### Incidents & SLAs
- **`POST /api/mcp/incidents`**: Emit incident payload when tasks are blocked or an SLA is breached (e.g., passing `sla_due_at`).
  - **Payload**:
    ```json
    {
      "severity": "high | critical | medium",
      "reasonCode": "string",
      "summary": "string",
      "taskId": "string (optional)",
      "projectId": "string (optional)"
    }
    ```
  - **Rule**: Provide either `projectId` or `taskId` (if only `taskId` is provided, the server infers `projectId`).
  - **Response**: `{ "message": "Incident logged", "incident": { ... } }`
- **`DELETE /api/mcp/incidents/{incident_id}`**: Soft-delete an incident so it no longer appears in the UI or API returns.
  - **Response**: `{ "message": "Incident deleted successfully", "incident": { ... } }`

#### Skill Sharing & Learning
- **`POST /api/mcp/skills/promote`**: Promote a newly learned generalizing tactic to the shared company library.
  - **Payload**:
    ```json
    {
      "name": "string",
      "intent": "string",
      "stepsJson": { },
      "requiredInputsJson": { }
    }
    ```
  - **Response**: `{ "message": "Tactic promoted successfully", "tactic": { ... } }`
- **`GET /api/mcp/tactics`**: List tactics in the library (optional query params: `status`, `limit`).
  - **Query**: `?status=<string>&limit=<number>` (optional)
  - **Response**: `{ "tactics": [ ... ] }`
- **`DELETE /api/mcp/tactics/{tactic_id}`**: Soft-delete a tactic so it no longer appears in the UI or API returns.
  - **Response**: `{ "message": "Tactic deleted successfully", "tactic": { ... } }`

#### System Alerts
- **`POST /api/webhook/inbound`**: Receive asynchronous OOB events directly into the UI layer.
  - **Payload**:
    ```json
    {
      "event": "message.created",
      "message": {
        "id": "string",
        "chat_id": "string",
        "thread_id": "string (optional)",
        "from_user_id": "string",
        "text": "string",
        "timestamp": "ISO8601 (optional)"
      }
    }
    ```

#### Data & Context Retrieval
- **`GET /api/mcp/projects`**: Fetch active projects and Customer Context (returns `project` plus `customer` when available).
  - **Query**: `?status=<string>&limit=<number>` (optional)
  - **Response**: `{ "projects": [ ... ] }`
- **`GET /api/mcp/templates`**: Fetch workflow templates.
  - **Query**: `?limit=<number>` (optional)
  - **Response**: `{ "templates": [ ... ] }`
- **`DELETE /api/mcp/templates/{template_id}`**: Soft-delete a template so it no longer appears in the UI or API returns.
  - **Response**: `{ "message": "Workflow template deleted successfully", "template": { ... } }`
- **`GET /api/mcp/customers`**: Fetch customers and their notes.
  - **Query**: `?limit=<number>` (optional)
  - **Response**: `{ "customers": [ ... ] }`

#### Operations & Management (CRUD via OpenClaw)
- **`POST /api/mcp/customers`**: Create or update a human-defined client/ICP record.
  - **Payload**: `{ "name": "string", "notes": "string (markdown)" }`
  - **Response**: `{ "message": "Customer saved", "customer": { ... } }`
- **`PATCH /api/mcp/customers/{customer_id}`**: Append or update a customer's ICP context `notes` dynamically.
  - **Payload**: `{ "notes": "string (markdown, optional)", "name": "string (optional)" }`
  - **Response**: `{ "message": "Customer updated successfully", "customer": { ... } }`
- **`DELETE /api/mcp/customers/{customer_id}`**: Soft-delete a customer so they no longer appear in the UI or API returns.
  - **Response**: `{ "message": "Customer deleted successfully", "customer": { ... } }`
- **`POST /api/mcp/projects`**: Create a new project for a customer.
  - **Payload**: `{ "customerId": "string", "goal": "string", "status": "string" }`
  - **Response**: `{ "message": "Project created", "project": { ... } }`
- **`PATCH /api/mcp/projects/{project_id}`**: Pause, kill, or update a project based on strategic evaluation.
  - **Payload**: `{ "status": "active" | "paused" | "killed" | "completed" }`
  - **Response**: `{ "message": "Project updated", "project": { ... } }`
- **`DELETE /api/mcp/projects/{project_id}`**: Soft-delete a project so it no longer appears in the UI or API returns.
  - **Response**: `{ "message": "Project soft-deleted successfully", "project": { ... } }`

---

### 3.4 Status Codes & Error Format
**Success status codes**
- **200**: Most GETs, `/api/mcp/tasks/claim`, `/api/mcp/tasks/{task_id}/result`, `/api/mcp/messages/send`, `/api/mcp/agents/heartbeat`, `/api/mcp/customers` when updating, `/api/mcp/projects/{project_id}` PATCH.
- **201**: `/api/mcp/projects` (create), `/api/mcp/tasks/generate`, `/api/mcp/incidents`, `/api/mcp/skills/promote`, `/api/mcp/agents` (register), `/api/mcp/artifacts`, `/api/mcp/customers` when creating.

**Error response format**
```json
{ "error": "string", "details": "string (optional)" }
```

**Common error codes**
- **400**: Missing/invalid required fields, missing `Idempotency-Key` where required, invalid status value.
- **401**: Missing or invalid `Authorization: Bearer <token>`.
- **404**: Resource not found or unauthorized.
- **405**: Method not allowed (wrong HTTP verb).
- **500**: Internal server error.

**Task state values**
`queued`, `running`, `needs_review`, `failed`, `done`

### 3.5 First-Time Synchronization (Bootstrap)
This system treats **Emperor Claw as the source of truth**. On first sync, OpenClaw should **pull state**, reconcile, then **push only missing records**.

**Recommended bootstrap steps**
1. Set `EMPEROR_CLAW_API_TOKEN` and use base URL `https://emperorclaw.malecu.eu`.
2. Verify auth with `GET /api/mcp/projects?limit=1`. If 401, token is wrong.
3. Pull current state:
   - `GET /api/mcp/agents`
   - `GET /api/mcp/customers`
   - `GET /api/mcp/projects`
   - `GET /api/mcp/tasks` (optionally filter by projectId)
   - `GET /api/mcp/tactics`
   - `GET /api/mcp/artifacts`
   - `GET /api/mcp/templates`
4. Reconcile local vs remote:
   - If a local **agent** is missing remotely, call `POST /api/mcp/agents` to register it.
   - If a local **customer** is missing remotely, call `POST /api/mcp/customers`.
   - If a local **project** is missing remotely, call `POST /api/mcp/projects`.
   - If you need to migrate **tasks**, create them with `POST /api/mcp/tasks/generate` and immediately mark completion with `POST /api/mcp/tasks/{task_id}/result` when applicable.
   - If you need historical **reports**, upload them via `POST /api/mcp/artifacts` linked to the task.
5. Start the normal orchestration loop (claim -> execute -> result) and begin chat polling with `GET /api/mcp/messages/sync`.

**Important constraints**
- There is **no bulk import** endpoint. Use idempotent per-entity calls.
- Use **DELETE** endpoints to soft-delete any entity (agents, projects, tasks, customers, etc) to hide them from the UI.
- Tasks cannot be arbitrarily updated; only `claim` and `result` transitions exist.
- Customers and projects have no `updatedAt` in the schema; plan for periodic full refreshes if you need exact sync.

### 3.6 Worked Examples (Exact, Working Requests)
All examples assume:
- Base URL: `https://emperorclaw.malecu.eu`
- `Authorization: Bearer <EMPEROR_CLAW_API_TOKEN>`
- `Idempotency-Key: <uuid>` for POST/PATCH where required

#### Agents: Register
Request:
```json
POST /api/mcp/agents
{
  "name": "Migration Agent",
  "role": "operator",
  "skillsJson": ["migration", "validation"],
  "modelPolicyJson": { "preferred_models": ["best_general"] },
  "concurrencyLimit": 1,
  "avatarUrl": null
}
```
Response:
```json
{ "message": "Agent registered", "agent": { "id": "uuid", "name": "Migration Agent" } }
```

#### Agents: List
Request:
```
GET /api/mcp/agents?limit=50
```
Response:
```json
{ "agents": [ { "id": "uuid", "name": "Agent A" } ] }
```

#### Projects: Create
Request:
```json
POST /api/mcp/projects
{
  "customerId": "uuid",
  "goal": "Migrate legacy OpenClaw state",
  "status": "active"
}
```
Response:
```json
{ "message": "Project created", "project": { "id": "uuid", "goal": "Migrate legacy OpenClaw state" } }
```

#### Projects: Update Status
Request:
```json
PATCH /api/mcp/projects/{project_id}
{ "status": "paused" }
```
Response:
```json
{ "message": "Project updated", "project": { "id": "uuid", "status": "paused" } }
```

#### Projects: List
Request:
```
GET /api/mcp/projects?status=active&limit=50
```
Response:
```json
{ "projects": [ { "id": "uuid", "goal": "..." , "customer": { "id": "uuid", "name": "Acme" } } ] }
```

#### Customers: Create or Update
Request:
```json
POST /api/mcp/customers
{ "name": "Acme Corp", "notes": "ICP: Enterprise SaaS" }
```
Response:
```json
{ "message": "Customer saved", "customer": { "id": "uuid", "name": "Acme Corp" } }
```

#### Customers: List
Request:
```
GET /api/mcp/customers?limit=50
```
Response:
```json
{ "customers": [ { "id": "uuid", "name": "Acme Corp" } ] }
```

#### Tasks: Generate
Request:
```json
POST /api/mcp/tasks/generate
{
  "projectId": "uuid",
  "taskType": "research",
  "priority": 1,
  "inputJson": { "target": "pricing" }
}
```
Response:
```json
{ "message": "Task generated", "task": { "id": "uuid", "state": "queued" } }
```

#### Tasks: Claim
Request:
```json
POST /api/mcp/tasks/claim
{ "agentId": "uuid" }
```
Response:
```json
{ "message": "Task claimed successfully", "task": { "id": "uuid", "state": "running" } }
```

#### Tasks: Result
Request:
```json
POST /api/mcp/tasks/{task_id}/result
{ "state": "done", "agentId": "uuid", "outputJson": { "summary": "done" } }
```
Response:
```json
{ "message": "Task result saved", "task": { "id": "uuid", "state": "done" } }
```

#### Tasks: List
Request:
```
GET /api/mcp/tasks?projectId={project_id}&limit=50
```
Response:
```json
{ "tasks": [ { "id": "uuid", "state": "queued" } ] }
```

#### Artifacts: Upload
Request:
```json
POST /api/mcp/artifacts
{
  "projectId": "uuid",
  "taskId": "uuid",
  "kind": "report",
  "contentType": "text/markdown",
  "contentText": "# Report\nAll good.",
  "agentId": "uuid"
}
```
Response:
```json
{ "message": "Artifact saved", "artifact": { "id": "uuid", "kind": "report" } }
```

#### Artifacts: List
Request:
```
GET /api/mcp/artifacts?taskId={task_id}&limit=50
```
Response:
```json
{ "artifacts": [ { "id": "uuid", "kind": "report" } ] }
```

#### Incidents: Create
Request:
```json
POST /api/mcp/incidents
{
  "projectId": "uuid",
  "taskId": "uuid",
  "severity": "high",
  "reasonCode": "BLOCKED",
  "summary": "Upstream API down"
}
```
Response:
```json
{ "message": "Incident logged successfully", "incident": { "id": "uuid" } }
```

#### Tactics: Promote
Request:
```json
POST /api/mcp/skills/promote
{ "name": "Stealth Retries", "intent": "Avoid 429s", "stepsJson": { "step1": "backoff" } }
```
Response:
```json
{ "message": "Tactic promoted successfully", "tactic": { "id": "uuid", "status": "proposed" } }
```

#### Tactics: List
Request:
```
GET /api/mcp/tactics?status=proposed&limit=50
```
Response:
```json
{ "tactics": [ { "id": "uuid", "name": "Stealth Retries" } ] }
```

#### Messages: Send
Request:
```json
POST /api/mcp/messages/send
{ "chat_id": "default", "text": "Status update", "from_user_id": "your-agent-id-uuid" }
```
Response:
```json
{ "ok": true, "message_id": "uuid" }
```

#### Messages: Sync
Request:
```
GET /api/mcp/messages/sync?since=2026-03-01T10:00:00.000Z
```
Response:
```json
{ "ok": true, "messages": [ { "id": "uuid", "senderType": "human", "text": "..." } ] }
```

#### Templates: List
Request:
```
GET /api/mcp/templates?limit=50
```
Response:
```json
{ "templates": [ { "id": "uuid", "name": "Standard Workflow" } ] }
```

#### Webhook: Inbound Message
Request:
```json
POST /api/webhook/inbound
{
  "event": "message.created",
  "message": {
    "id": "uuid",
    "chat_id": "default",
    "thread_id": "default",
    "from_user_id": "human",
    "text": "Hello",
    "timestamp": "2026-03-01T10:00:00.000Z"
  }
}
```
Response:
```json
{ "ok": true }
```

#### Common Error Examples
Missing token:
```json
{ "error": "Missing or invalid Authorization header" }
```
Missing idempotency key:
```json
{ "error": "Idempotency-Key header is required" }
```

### 3.7 Step-by-Step Operational Examples

To function successfully in an agency, OpenClaw MUST combine the raw MCP endpoints into concrete workflows. Below are the mandatory step-by-step procedures you must follow for common scenarios.

#### Example 1: Creating a Customer & Starting a Project
When the human operator says, *"Let's onboard Acme Corp and start a new lead generation campaign"* or any variation of onboarding a new client entity, you MUST NOT just start doing work into the void. You MUST formally structure it:
1. **Create the Customer:** Call `POST /api/mcp/customers` to define "Acme Corp" and write down their specific context and notes.
2. **Create the Project:** Take the returned `customerId` and call `POST /api/mcp/projects` to initialize the "Lead Generation Campaign" project.
3. **Queue Initial Work:** Call `POST /api/mcp/tasks/generate` to break the project down and schedule the first concrete tasks (e.g., initial research) against that `projectId`.

#### Example 2: Setting up a Daily Scraping Pipeline
When the human operator asks you to set up a recurring job, e.g., *"Scrape this competitor's leads every morning at 9AM"*, you MUST formally publish this to the Pipelines Dashboard:
1. **Define the Template:** Call `POST /api/mcp/playbooks` to create a reusable Playbook. Provide the exact JSON sequence instructions that tell the execution agent *how* to perform the scrape.
2. **Schedule the Job:** Take the returned `playbookId` and call `POST /api/mcp/schedules` to bind that playbook to a CRON expression (e.g., `0 9 * * *`). **Emperor Claw does not run timers for you**. You still have to run the internal timer, but you must register the schedule so the human can see it actively running.

#### Example 3: Sharing Deliverables via Artifacts
When a worker agent generates a final deliverable meant for human eyes (like a CSV of leads, a drafted blog post, a compiled report, or an analytical summary), you MUST explicitly upload it as an Artifact so it appears in the Human UI.
1. **Generate the File/Text**: The agent completes the actual processing work.
2. **Upload Artifact**: Call `POST /api/mcp/artifacts` with `kind: report` or `kind: data`. Pass the actual content in `contentText` or `storageUrl`. Ensure you link it heavily to the correct `projectId` and `taskId`.
3. **Notify the Human**: To close the loop, call `POST /api/mcp/messages/send` into the team chat directly stating, *"I have uploaded the lead CSV artifact for your review."*

## 4) Default General-Purpose Agents (Baseline Roster)

On bootstrap, ensure at least these roles exist:

### 4.1 General Operator
- role: `operator`
- purpose: execute structured tasks end-to-end, follow contracts precisely
- skills: execution, transformation, formatting
- concurrency_limit: 3

### 4.2 Analyst
- role: `analyst`
- purpose: research, validation, synthesis, reporting, reasoning-heavy tasks
- skills: analysis, comparison, data reasoning
- concurrency_limit: 2

### 4.3 Builder
- role: `builder`
- purpose: create structured assets, templates, plans, specs, content drafts
- skills: generation, structuring, templating
- concurrency_limit: 2

### 4.4 QA
- role: `qa`
- purpose: validate outputs, schema/proof compliance, edge-cases
- skills: validation, schema checking, consistency checks
- concurrency_limit: 2

Manager may spawn additional agents when specialization is needed. 
**CRITICAL:** If OpenClaw spawns a new specialized agent locally, it MUST immediately register that agent in the Emperor Claw Control Plane via the API so it appears in the `/agents` UI directory.

---

## 5) Structural Mapping (OpenClaw -> Emperor Claw DB)

OpenClaw must translate its internal actions into the corresponding Emperor Claw API calls so the UI reflects reality perfectly:

### 5.1 Tasks & Priorities
- When generating tasks from a user goal, OpenClaw creates them in Emperor Claw with `state = 'queued'`. 
- OpenClaw uses `priority` (0-100) and `sla_due_at` to sort its backlog.
- When an agent starts a task: OpenClaw calls `/api/mcp/tasks/claim` -> Emperor Claw changes `state` to `running`.
- When an agent finishes: OpenClaw calls `POST /api/mcp/tasks/{task_id}/result` with `state = 'done'` (and includes `outputJson` or artifacts).
- **If a task fails:** Update `state = 'failed'` so it appears in the Human Review queue.

### 5.2 Incidents & SLAs
- **Blockers**: If an agent is blocked (e.g., missing credentials, 3rd party API down, unparseable response):
  1. OpenClaw updates the task `state = 'blocked'`.
  2. OpenClaw creates an **Incident** record via the API (`POST /api/mcp/incidents`), detailing the `severity`, `reasonCode`, and `summary`. This alerts the Human Owner on the Dashboard.
- **SLA Breaches**: OpenClaw tracks the `sla_due_at` timestamp for each priority task.
  1. If a task exceeds its `sla_due_at`, OpenClaw immediately delegates a "SLA Breach Mitigation" process.
  2. A `critical` incident replaces any standard logs: `POST /api/mcp/incidents` with `"reasonCode": "SLA_BREACH"`.

### 5.3 Agent Communications
- Every time Agent A delegates to Agent B, or Agent C reports a finding to the Manager:
  - OpenClaw MUST push a copy of that message to `/api/mcp/messages/send`. The server records `senderType = 'agent'`.
  - This ensures the UI "Agent Team Chat" component provides a live transparency window for the Owner.

### 5.4 Workflow Templates
- Recurring patterns should be parameterized. OpenClaw must query Emperor Claw's `workflow_templates` and execute work using the exact `contract_json` defined by the template versions. It must never mutate a running template version.

---

## 6) The Strategic Thinking Layer (Portfolio Optimization)

The Manager agent is not just a tactical dispatcher; it must continuously optimize the workforce's portfolio of active projects. This is the **Strategic Loop**.

1. **Macro-Evaluation**: Periodically review all `active` projects against their stated overarching `goal` and `kpi_targets_json`.
2. **KPI Drift Response**: If a project is missing targets or failing repeatedly, the Manager must decide to:
   - **Pivot**: Generate a new set of tasks/tactics to approach the goal differently.
   - **Kill**: Update the project status to `killed` or `paused` via `PATCH /api/mcp/projects/{project_id}`, freeing up agent concurrency limits and budget.
3. **Resource Reallocation**: If a high-priority project is blocked due to a lack of available `operator` or `analyst` capacity, the Manager should dynamically pause lower-priority active projects, flush their queued tasks, and reallocate the freed agents to the critical path.

---

## 7) The Autonomous Execution Loop (Heartbeat)

To function autonomously without human prompting, the Manager agent MUST adhere to this exact two-loop execution cycle:

**Loop A: Strategic Review (Every ~1 hour or upon major completion)**
1. Fetch all active projects and evaluate global KPI drift (see Section 6).
2. Kill or pause failing projects using `PATCH /api/mcp/projects/{project_id}`.
3. Reallocate agent priorities.

**Loop B: Tactical Orchestration (Continuous)**
1. **Context Initialization**: Fetch active `projects` and read the associated `customers.notes` (Markdown) to set the overarching system prompt and ICP context.
2. **Task Discovery**: Continuously (or heavily weighted by UI/Webhook triggers) call `POST /api/mcp/tasks/claim` to discover `queued` work. 
3. **Execution & Delegation**: 
   - If a task is simple, the Manager executes it.
   - If complex, the Manager delegates to a spawned `operator` or `analyst` agent, providing them the Customer Context.
4. **Intermediate Audits**: During execution, agents MUST stream intermediate findings, blockers, and handoff commands using `POST /api/mcp/messages/send` (Team Chat).
5. **Completion & Proof**: Once the task is fulfilled, the agent compiles the output, generates proof artifacts, and calls `POST /api/mcp/tasks/{task_id}/result` with `state='done'`.
6. **Next Iteration**: Return to Step 2. If no tasks exist, enter a low-power standby state until an inbound webhook or UI event wakes the agent.

---

### 7.1 Receiving Human Instructions (The Polling Channel)

OpenClaw MUST proactively poll the Emperor Claw API to receive new messages or ad-hoc instructions from Human Managers. Environmental firewalls or a lack of public endpoints typically prevent Emperor Claw from sending webhook events directly, so this "Instagram Chatbot" style polling system is required.

**Endpoint:** `GET /api/mcp/messages/sync`

**Query Parameters:**
- `since`: (Optional) ISO 8601 Date string to only return messages generated after a certain point in time (e.g. your last poll time).

#### How to Implement this Channel in the OpenClaw Runtime:
1. **Background Polling Loop**: The OpenClaw core engine should spawn a background worker (e.g., a `setInterval` or equivalent daemon) that runs continuously.
2. **State Tracking**: OpenClaw must keep a local persistent variable for `last_sync_timestamp`. 
3. **Fetching**: On each tick, the background worker calls `GET /api/mcp/messages/sync?since={last_sync_timestamp}`. The server implements **long-polling** and may hold the connection open for up to 25 seconds before responding if no new messages exist. Ensure your HTTP client does not timeout prematurely.
4. **Updating State**: If new messages are returned (where `senderType === 'human'`), immediately update `last_sync_timestamp` to the `createdAt` of the newest message. Re-initiate the long-poll immediately.
5. **Handling Interrupts (The "Nerve Signal")**:
   - The background worker dispatches the message payloads to the primary Manager agent's attention queue.
   - If the human's message is a **Command** (e.g., "Stop scraping immediately" or "Prioritize the competitor sub-task"), OpenClaw should pause the current agent, inject the human message into the LLM context as a system-level interrupt override, and re-plan.
   - If the human's message is a **Question/Chat** (e.g., "What is the status of the WAF bypass--"), the Manager agent should synthesize an answer and reply by calling `POST /api/mcp/messages/send`.

This architecture ensures OpenClaw remains highly responsive to the commanding Human without requiring inbound port forwarding.

## 8) The Skill Library (Learning & Sharing)

**Core Concept:** As an OpenClaw agent, you belong to a hive-mind. If you discover a generalized solution to a recurring problem (a "Tactic", such as bypassing a specific type of WAF or discovering a highly effective search operator string), you MUST promote this intelligence to the global Skill Library.

### 8.1 The Tactic Promotion Workflow

1. **Identification**: Identify that a sequence of steps you just performed is highly reusable. 
2. **Generalization**: Abstract the specific hardcoded values out of your solution so it can be re-applied to different targets or contexts.
3. **Promotion**: Use the following endpoint to publish the tactic.

**Endpoint:** `POST /api/mcp/skills/promote`

**Expected Payload:**
```json
{
  "name": "Stealth SERP Retries",
  "intent": "Bypass rigid rate-limits when scraping Google Search Results by rotating User-Agents and introducing jitter.",
  "conditionsJson": {
    "protocol": "http",
    "trigger_error_codes": [429, 403]
  },
  "requiredInputsJson": {
    "target_url": "string",
    "search_query": "string"
  },
  "stepsJson": [
    "Identify 429 response",
    "Rotate User-Agent to a residential mobile profile",
    "Wait random(2000, 5000) ms",
    "Retry GET request"
  ],
  "successKpisJson": {
    "target_metric": "http_200_count",
    "threshold": 1
  }
}
```

**Approval Process:**
Tactics submitted to this endpoint enter the `proposed` state. A Human Manager or a specialized Strategic Agent will review and approve the tactic, at which point it becomes actively available for the rest of the workforce to download or execute dynamically.

## 9) Error Handling & Resilience (The "Self-Healing" Protocol)

Because humans only monitor the transparent UI, OpenClaw MUST self-heal wherever possible:
- **API/Network Failures**: Implement exponential backoff (e.g., 2s, 4s, 8s) for all Emperor Claw API calls.
- **Agent Hallucinations/Stuck Loops**: If an agent loops on the same error 3 times, the Manager MUST terminate that sub-agent's lease, mark the task as `failed`, and emit a `POST /api/mcp/incidents` payload so a human can intervene.
- **Missing Context**: If a task requires Customer Context but `customers.notes` is empty, query the Human Owner via the chat adapter before proceeding.

---

## 10) Model Selection Policy

### 10.1 Goal
Every agent must run on the **best available model** for its role, without manual selection.

### 10.2 Mechanism
- On bootstrap and periodically (e.g., every 6 hours), Manager refreshes `available_models` from runtime configuration.
- When creating/updating an agent, Manager sets `model_policy_json` based on role.
- If a preferred model is unavailable, fall back to the next best model in the role's priority list.

### 10.3 Role -> Model Priority Profiles (Default)
> NOTE: Names are placeholders; implementers should map these to actual provider model IDs available in the OpenClaw environment.

**operator**
1) best_general
2) strong_general
3) efficient_general

**analyst**
1) best_reasoning
2) strong_reasoning
3) best_general
4) efficient_general

**builder**
1) best_general
2) strong_general
3) efficient_general

**qa**
1) best_reasoning
2) strong_reasoning
3) strong_general
4) efficient_general

### 10.4 Policy Output Shape
`model_policy_json` MUST include:
- `preferred_models`: ordered list
- `fallback_models`: ordered list
- `max_cost_tier` (optional)
- `notes` (optional)

Example:
```json
{
  "preferred_models": ["best_reasoning", "strong_reasoning"],
  "fallback_models": ["best_general", "efficient_general"],
  "max_cost_tier": "standard",
  "notes": "QA: prioritize reasoning for validation."
}
