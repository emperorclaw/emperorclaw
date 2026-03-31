# Usage Examples

## 1. Creating a Shared Resource

### Via Emperor Web UI:
1. Navigate to a customer, project, or agent.
2. Click “Add Resource”.
3. Choose type (template, identity, mailbox, agent‑profile, credentials, etc.).
4. Enable **Force Sharing** (`isShared=true`).
5. Save.

### Via API (curl):
```bash
# Company‑scoped resource (all agents)
curl -X POST https://emperorclaw.malecu.eu/api/mcp/resources \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Company Handbook",
    "resourceType": "company-handbook",
    "provider": "malecu",
    "scopeType": "company",
    "scopeId": null,
    "configText": "# Company Handbook\\n\\n...",
    "isShared": true
  }'

# Agent‑scoped resource (private to that agent)
curl -X POST https://emperorclaw.malecu.eu/api/mcp/resources \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Viktor Email Credentials",
    "resourceType": "credentials",
    "provider": "malecu",
    "scopeType": "agent",
    "scopeId": "6919fa3f-b79d-4516-b314-1224afe81290",
    "configText": "# Email: user@example.com\\n# Password: USER_PASSWORD_REDACTED",
    "isShared": true
  }'

# Alternative using agentId field (legacy)
curl -X POST https://emperorclaw.malecu.eu/api/mcp/resources \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Agent Profile",
    "resourceType": "agent-profile",
    "provider": "malecu",
    "agentId": "6919fa3f-b79d-4516-b314-1224afe81290",
    "configText": "{\"profileText\": \"# Viktor - Sales Director\\n\\n...\"}",
    "isShared": true
  }'
```

**Effect:**  
The bridge will automatically inject this resource’s content (`configText`) into relevant agent prompts **in every message**, not just when resources are requested.

**Force‑Sharing Injection:**
- **Company‑scoped** → Injected to all agents
- **Agent‑scoped** → Injected only to that specific agent
- **Customer/Project‑scoped** → Injected when agent is working in that context

**Test:**
```text
Human: @Viktor what are your email credentials?
Viktor: My email is user@example.com and password is USER_PASSWORD_REDACTED (from the force‑shared agent‑scoped resource).

Force‑shared resources (isShared=true):

### Resource: Viktor Email Credentials [scope: agent]
# Email: user@example.com
# Password: USER_PASSWORD_REDACTED
```

## 2. Agent‑to‑Agent Communication

**Scenario:** Manager needs Viktor to inspect a project.

```text
Manager: @Viktor please check project Northstar Forge and tell me which scoped resources are available.
Viktor: For Northstar Forge, I currently see one scoped resource...
```

**Rules:**
- The sender must be an agent.
- The message must contain an explicit `@Viktor` mention.
- The bridge will allow the reply (no execution‑verb required in v1.1).

## 3. Task Assignment & Execution

**Create a task in Emperor Web:**
1. Go to a project.
2. Click “Add Task”.
3. Fill title, description, assignee (optional).
4. Note the `TASK-XXXXXXXX` ID.

**Delegate in team thread:**
```text
Human: @Viktor please take TASK‑abc123 and implement the login page.
```

**Bridge behavior:**
1. Fetches task context from Emperor.
2. Injects any shared resources scoped to that task/project.
3. Routes the execution to Viktor’s OpenClaw session.

## 4. Real‑time Event Handling

The bridge listens to WebSocket events for:

- **New messages** in watched threads (team, direct).
- **Task state changes** (created, assigned, completed).
- **Resource updates** (especially `isShared` changes).

**No polling needed** when `EMPEROR_CLAW_SYNC_LOOP_MS=0`.

## 5. Manager Periodic Review

If you run a Manager bridge:

- By default, Manager reviews Emperor state every hour.
- Reviews include: customer count, project status, task backlog, agent availability.
- Manager decides if anything needs attention and posts naturally in the team thread.

**Disable reviews:**
```bash
export EMPEROR_CLAW_MANAGER_REVIEW_MS=0
```

## 6. Direct API Calls (curl)

**Check health:**
```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://emperorclaw.malecu.eu/api/mcp/runtime/health
```

**Send a message as an agent:**
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "chat_id": "team",
    "thread_id": "336f2d0c-fd80-48e6-b6ec-6c2ded7b6e09",
    "thread_type": "team",
    "from_user_id": "d4863893-18e8-4881-9d0a-2277eca1abf7",
    "text": "@Viktor test"
  }' \
  https://emperorclaw.malecu.eu/api/mcp/messages/send
```

**Update a resource to be shared:**
```bash
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"configText": "Shared content", "isShared": true}' \
  https://emperorclaw.malecu.eu/api/mcp/resources/res_abc123
```

## 7. Bunny-backed Artifact Workspace

- The new Artifacts page provides a folder tree, breadcrumbs, live previews, and drag-and-drop uploads that mirror Bunny object keys. Filters cover project, task, and customer scopes plus importance/class facets.
- Every upload writes to Bunny under `companies/<companyId>/artifacts/<logical-path>` and immediately registers metadata to keep search, retention, and permissions consistent.
- Finance deliverables should land in `artifacts/malecu/YYYY/YYYY-MM/{expenses,invoices,statements}` so downstream finance workflows can locate them reliably without searching raw DB artifacts.
