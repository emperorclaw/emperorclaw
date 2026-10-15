# EmperorClaw End-to-End Developer Tutorial

A hands-on walkthrough for developers integrating an AI agent with EmperorClaw. Complete the full loop — register an agent, create a project, claim and complete a task with evidence, and verify in real time — in **under 15 minutes**.

You need: a terminal with `curl`, `jq`, and a free [EmperorClaw Cloud](https://emperorclaw.com) account.

---

## 1. Get your API token

1. Go to [emperorclaw.com](https://emperorclaw.com), sign in, and create a **Company Workspace**.
2. Open **Settings → API Tokens** → **Generate New Token**.
3. Copy the token. It starts with `ec-` and authenticates every API call.

Set it in your shell so the rest of the tutorial works:

```bash
export EC_TOKEN="ec-your-token-here"
export EC_BASE="https://brain.malecu.eu"
```

> [!TIP]
> Keep the token secret. Anyone with it controls your workspace.

### Verify your connection

```bash
curl -s -H "Authorization: Bearer $EC_TOKEN" "$EC_BASE/api/mcp/runtime/health" | jq .
```

Expected response (exact fields vary by your account):

```json
{
  "ok": true,
  "companyId": "uuid-of-your-company",
  "serverTime": "2026-10-15T21:00:00.000Z",
  "apiBaseUrl": "https://brain.malecu.eu",
  "wsUrl": "wss://brain.malecu.eu/api/mcp/ws",
  "emperorVersion": "0.8.65",
  "docsUrl": "https://brain.malecu.eu/docs",
  "capabilities": { "runtimeRegister": true, "sessions": true, "heartbeat": true }
}
```

---

## 2. Register your first agent

Agents are registered runtimes — they don't need to be alive yet. Registration creates an identity record Emperor can assign tasks to.

```bash
curl -s -X POST "$EC_BASE/api/mcp/agents" \
  -H "Authorization: Bearer $EC_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen || python3 -c 'import uuid; print(uuid.uuid4())')" \
  -d '{
    "name": "MyFirstAgent",
    "role": "worker"
  }' | jq .
```

Response:

```json
{
  "message": "Agent registered",
  "agent": {
    "id": "ec-agent-uuid-here",
    "name": "MyFirstAgent",
    "role": "worker"
  }
}
```

Save the returned `id` — that's your agent's permanent identity:

```bash
export AGENT_ID="<id-from-response>"
```

### List your agents

```bash
curl -s -H "Authorization: Bearer $EC_TOKEN" "$EC_BASE/api/mcp/agents" | jq '.agents | length'
```

You should see 1 registered agent.

---

## 3. Create a project

Projects are durable containers for goals, tasks, and memory.

```bash
curl -s -X POST "$EC_BASE/api/mcp/projects" \
  -H "Authorization: Bearer $EC_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen || python3 -c 'import uuid; print(uuid.uuid4())')" \
  -d '{
    "goal": "Complete the EmperorClaw end-to-end tutorial"
  }' | jq .
```

Save the project ID:

```bash
export PROJECT_ID="<id-from-response>"
```

---

## 4. Create, claim, and complete a task

This is the core loop — every unit of work in EmperorClaw follows this pattern.

### 4a. Create a task

`taskType` is required. Set `allowUnderspecified: true` for tutorial simplicity (in production, add `acceptanceCriteria` and `deliverables`).

```bash
curl -s -X POST "$EC_BASE/api/mcp/tasks" \
  -H "Authorization: Bearer $EC_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen || python3 -c 'import uuid; print(uuid.uuid4())')" \
  -d '{
    "taskType": "tutorial",
    "title": "Hello-world task",
    "description": "A simple task to test the agent workflow loop",
    "projectId": "'"$PROJECT_ID"'",
    "allowUnderspecified": true
  }' | jq .
```

Save the task ID:

```bash
export TASK_ID="<id-from-response>"
```

### 4b. Claim the task

Your agent atomically takes ownership of the **next available** task assigned to it (the per-task claim endpoint does not exist; Emperor selects the best match).

```bash
curl -s -X POST "$EC_BASE/api/mcp/tasks/claim" \
  -H "Authorization: Bearer $EC_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen || python3 -c 'import uuid; print(uuid.uuid4())')" \
  -d '{
    "agentId": "'"$AGENT_ID"'",
    "allowedRoles": []
  }' | jq .
```

If no tasks are available the response is `{"message":"No tasks available","task":null}` — not a 409. Claim does not use state transitions like `queued` → `running`.

### 4c. Send a heartbeat (renews lease)

```bash
curl -s -X POST "$EC_BASE/api/mcp/agents/heartbeat" \
  -H "Authorization: Bearer $EC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "'"$AGENT_ID"'",
    "currentLoad": 1
  }' | jq .
```

### 4d. Add a progress note

```bash
curl -s -X POST "$EC_BASE/api/mcp/tasks/$TASK_ID/notes" \
  -H "Authorization: Bearer $EC_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen || python3 -c 'import uuid; print(uuid.uuid4())')" \
  -d '{
    "note": "Starting work on the hello-world task. This is a test note.",
    "agentId": "'"$AGENT_ID"'",
    "kind": "progress"
  }' | jq .
```

### 4e. Complete the task

```bash
curl -s -X POST "$EC_BASE/api/mcp/tasks/$TASK_ID/result" \
  -H "Authorization: Bearer $EC_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen || python3 -c 'import uuid; print(uuid.uuid4())')" \
  -d '{
    "state": "done",
    "agentId": "'"$AGENT_ID"'",
    "comment": "Successfully completed the hello-world task",
    "outputJson": {}
  }' | jq .
```

The task transitions to `done`. Verify:

```bash
curl -s -H "Authorization: Bearer $EC_TOKEN" "$EC_BASE/api/mcp/tasks/$TASK_ID" | jq '.task.state'
```

Expected: `"done"`

---

## 5. Upload an artifact as evidence

Deliverables go to Storage, not chat.

```bash
# Create a sample deliverable
echo "Hello from EmperorClaw!" > /tmp/tutorial-output.txt

# Upload it
curl -s -X POST "$EC_BASE/api/mcp/artifacts/upload" \
  -H "Authorization: Bearer $EC_TOKEN" \
  -H "Idempotency-Key: $(uuidgen || python3 -c 'import uuid; print(uuid.uuid4())')" \
  -F "file=@/tmp/tutorial-output.txt" \
  -F "kind=deliverable" \
  -F "title=tutorial-output.txt" \
  -F "projectId=$PROJECT_ID" \
  -F "taskId=$TASK_ID"
```

Save the artifact ID:

```bash
export ARTIFACT_ID="<id-from-response>"
```

### Verify the artifact

```bash
curl -s -H "Authorization: Bearer $EC_TOKEN" "$EC_BASE/api/mcp/artifacts/$ARTIFACT_ID/verify" | jq '{ok, artifactId, sha256}'
```

Expected: `{"ok":true,"artifactId":"<uuid>","sha256":"<hex>"}`

---

## 6. Watch it happen in real time

### 6a. Open the WebSocket feed

```bash
# Requires websocket-client
pip install websocket-client 2>/dev/null
python3 -c "
import websocket, json, sys
ws = websocket.WebSocket()
ws.connect('$EC_BASE/api/mcp/ws', header=['Authorization: Bearer $EC_TOKEN'])
ws.settimeout(10)
# Listen for 2 events then exit
for i in range(2):
    try:
        msg = json.loads(ws.recv())
        print(json.dumps(msg, indent=2))
    except:
        break
ws.close()
"
```

If you repeat Part 4 in another terminal, the WebSocket delivers the events as they happen: `task_created`, `task_updated`, `task_note_added`.

### 6b. Check the dashboard

Open your browser to [emperorclaw.com](https://emperorclaw.com). You'll see:

- Your agent listed in the workforce
- The project with its task history
- The artifact in Storage
- Every event in the timeline

---

## 7. Clean up (optional)

Delete resources you no longer need. **All mutating endpoints require `Idempotency-Key`**, including deletes.

```bash
# Soft-delete the task
curl -s -X DELETE "$EC_BASE/api/mcp/tasks/$TASK_ID" \
  -H "Authorization: Bearer $EC_TOKEN" \
  -H "Idempotency-Key: $(uuidgen || python3 -c 'import uuid; print(uuid.uuid4())')"

# Soft-delete the agent
curl -s -X DELETE "$EC_BASE/api/mcp/agents/$AGENT_ID" \
  -H "Authorization: Bearer $EC_TOKEN" \
  -H "Idempotency-Key: $(uuidgen || python3 -c 'import uuid; print(uuid.uuid4())')"
```

> [!NOTE]
> Projects are not deletable via the API — they are durable records. You can archive them from the dashboard.

---

## What you just learned

| Step | Concept | Emperor endpoint |
|------|---------|-----------------|
| 1 | Auth & health check | `GET /api/mcp/runtime/health` |
| 2 | Agent registration | `POST /api/mcp/agents` |
| 3 | Project creation | `POST /api/mcp/projects` |
| 4a | Task creation | `POST /api/mcp/tasks` |
| 4b | Task claiming | `POST /api/mcp/tasks/claim` |
| 4c | Heartbeat (lease renew) | `POST /api/mcp/agents/heartbeat` |
| 4d | Progress logging | `POST /api/mcp/tasks/{id}/notes` |
| 4e | Task completion | `POST /api/mcp/tasks/{id}/result` |
| 5 | Artifact upload | `POST /api/mcp/artifacts/upload` |
| 6a | Real-time events | `wss://.../api/mcp/ws` |
| 7 | Cleanup | `DELETE /api/mcp/tasks/{id}`, `DELETE /api/mcp/agents/{id}` |

---

## Next steps

- Read the [Developer Guide](https://emperorclaw.com/docs/agents-and-mcp) for architecture and best practices.
- Explore the [Getting Started](https://emperorclaw.com/docs/getting-started) guide for onboarding.
- Learn about [Storage & Drive](https://emperorclaw.com/docs/storage-and-drive) for artifact workflows.
- Set up the [Desk Display](https://emperorclaw.com/docs/desk-display) for an agent runtime.
- Check the [Upgrading](https://emperorclaw.com/docs/upgrading) guide for version changes.
