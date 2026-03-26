# Usage Examples

## 1. Creating a Shared Resource

**In Emperor Web:**
1. Navigate to a customer or project.
2. Click “Add Resource”.
3. Choose type (template, identity, mailbox, etc.).
4. Enable **Force Sharing** (`isShared=true`).
5. Save.

**Effect:**  
The bridge will automatically inject this resource’s `configText` into relevant agent prompts.

**Test:**
```text
Human: @Viktor what resources are available for Northstar Forge?
Viktor: I see one scoped resource: Northstar Product Brief [type=template, provider=emperor-demo, mode=inject].

Auto‑injected resource context (isShared=true):

### Resource: Northstar Product Brief
{"title": "Product Brief", "description": "Shared template..."}
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