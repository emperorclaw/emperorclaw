# Usage Examples

## Terminology For Humans And Agents

The product UI uses human-friendly names while the MCP API keeps stable endpoint names:

- **Knowledge & Rules** in the UI is the `/resources` API.
- **Storage** in the UI is the `/artifacts` and `/folders` APIs.

Use Knowledge & Rules/resources only for reusable context: doctrine, SOPs, business rules, templates, credentials metadata, account notes, and reference instructions.

Do not put logs, task progress, final reports, CSV exports, screenshots, PDFs, invoices, raw tool output, or one-off work results in Knowledge & Rules. Use task notes for progress and Storage/artifacts for files, proofs, and deliverables.

## 1. Creating a Shared Knowledge & Rules Entry

### Via Emperor Web UI:
1. Navigate to a customer, project, or agent.
2. Click “Add Resource”.
3. Choose type (template, identity, mailbox, agent‑profile, credentials, etc.).
4. Enable **Force Sharing** (`isShared=true`).
5. Save.

### Via API (curl):
```bash
# Company‑scoped resource (all agents)
curl -X POST https://emperorclaw.example.com/api/mcp/resources \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Company Handbook",
    "resourceType": "company-handbook",
    "provider": "your-org",
    "scopeType": "company",
    "scopeId": null,
    "configText": "# Company Handbook\\n\\n...",
    "isShared": true
  }'

# Agent‑scoped resource (private to that agent)
curl -X POST https://emperorclaw.example.com/api/mcp/resources \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Agent Email Credentials",
    "resourceType": "credentials",
    "provider": "your-org",
    "scopeType": "agent",
    "scopeId": "<agent-uuid>",
    "configText": "# Email: agent@example.com\\n# Password: (set via environment variable)",
    "isShared": true
  }'

# Alternative using agentId field (legacy)
curl -X POST https://emperorclaw.example.com/api/mcp/resources \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Agent Profile",
    "resourceType": "agent-profile",
    "provider": "your-org",
    "agentId": "<agent-uuid>",
    "configText": "{\"profileText\": \"# Agent Name - Role\\n\\n...\"}",
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
Human: @AgentName what are your email credentials?
AgentName: My email is agent@example.com and password is <your-password> (from the force‑shared agent‑scoped resource).

Force‑shared resources (isShared=true):

### Resource: Agent Email Credentials [scope: agent]
# Email: agent@example.com
# Password: (set via environment variable)
```

## 2. Agent‑to‑Agent Communication

**Scenario:** Manager needs Viktor to inspect a project.

```text
Manager: @AgentName please check project Northstar Forge and tell me which scoped resources are available.
AgentName: For Northstar Forge, I currently see one scoped resource...
```

**Rules:**
- The sender must be an agent.
- The message must contain an explicit `@AgentName` mention.
- The bridge will allow the reply (no execution‑verb required in v1.1).

## 3. Task Assignment & Execution

**Create a task in Emperor Web:**
1. Go to a project.
2. Click “Add Task”.
3. Fill title, description, assignee (optional).
4. Note the `TASK-XXXXXXXX` ID.

**Delegate in team thread:**
```text
Human: @AgentName please take TASK‑abc123 and implement the login page.
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
  https://emperorclaw.example.com/api/mcp/runtime/health
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
    "text": "@AgentName test"
  }' \
  https://emperorclaw.example.com/api/mcp/messages/send
```

**Update a resource to be shared:**
```bash
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"configText": "Shared content", "isShared": true}' \
  https://emperorclaw.example.com/api/mcp/resources/res_abc123
```

## 7. Storage: Bunny-backed Artifact Workspace

- The **Storage** page provides a folder tree, breadcrumbs, live previews, and drag-and-drop uploads that mirror Bunny object keys. The API name for these records is `artifacts`.
- Uploads are now customer-first. A normal upload only needs a file plus a customer or project; task is optional and only applies when the artifact belongs to a project workflow.
- The upload modal keeps `kind`, `artifactClass`, `importance`, and `metadataJson` under `Advanced` so routine file uploads stay lightweight while structured metadata is still available when needed.
- Every upload writes to Bunny under `companies/<companyId>/artifacts/<logical-path>` and immediately registers metadata to keep search, retention, and permissions consistent.
- Finance deliverables should land in `artifacts/acme/YYYY/YYYY-MM/{expenses,invoices,statements}` so downstream finance workflows can locate them reliably without searching raw DB artifacts.
