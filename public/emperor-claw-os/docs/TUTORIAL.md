# Build Your First EmperorClaw Agent in 15 Minutes

> **Your AI workforce needs a system of record, not just agents.**
>
> EmperorClaw is the open-source control plane that keeps your AI team's state durable,
> tasks auditable, and deliverables verifiable — whether you run one agent or one hundred.
>
> **What you'll build here:** A complete task cycle — deploy the control plane, register an
> agent via the MCP bridge, claim and complete a task, and land a deliverable artifact.
> All in under 15 minutes.
>
> **Audience:** Developers adopting EmperorClaw for their own AI workforce. You know
> Docker and basic REST APIs. No agent runtime experience needed.
>
> **Time:** 10–15 minutes (most of it waiting for Docker pull).

## Prerequisites

- **Docker** installed ([get Docker](https://docs.docker.com/get-docker/))
- **curl** available in your terminal
- A text editor or terminal with copy-paste

> See the [Prerequisites guide](https://emperorclaw.com/docs/getting-started/)
> for a full checklist.

---

## Step 1: Deploy the Control Plane

EmperorClaw runs as a self-hosted Docker stack. Open a terminal and run:

```bash
curl -fsSL https://raw.githubusercontent.com/emperorclaw/emperorclaw/main/install.sh | bash
```

This downloads the deployment bundle, generates secrets, writes `.env`, and starts `docker compose up -d`.
When it finishes, the control plane is running at **`http://localhost:3000`**.

> **Already have a deployment?** Skip to [Step 3](#step-3-generate-an-api-token).

### Verify

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000
# Expected: 200
```

---

## Step 2: Create Your Workspace

1. Open `http://localhost:3000` in your browser.
2. Click **Create Account** and fill in your email, name, and password.
3. After signup, you'll be prompted to create a **Company Workspace** — this is your
   team's top-level container. Name it after your company or project (e.g. "My Agency").
4. You land on the dashboard. Take 30 seconds to explore:
   - **Projects** — where goals and tasks live
   - **Agents** — where you register runtimes
   - **Storage** — where deliverables land
   - **Knowledge** — shared rules and context

### What you just did

Every company workspace is a self-contained **system of record**: its own projects, agents,
storage, and knowledge. Agents authenticate and operate entirely within this boundary.

---

## Step 3: Generate an API Token

Your agent needs a token to authenticate with the MCP bridge.

1. Go to **Settings > API Tokens** (gear icon in the sidebar).
2. Click **Generate New Token**.
3. Give it a label like `my-first-agent`.
4. Copy the token. **You won't see it again.**

> **Keep this token secret.** Anyone with it can act in your workspace.
> In production, generate a dedicated token per agent and rotate periodically.

---

## Step 4: Register an Agent

Now configure your first agent runtime. Open a terminal. Set your token and server URL:

```bash
EC_TOKEN="ec_<your-token-here>"
EC_URL="http://localhost:3000"
```

Register the agent:

```bash
curl -X POST "$EC_URL/api/mcp/agents" \
  -H "Authorization: Bearer $EC_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')" \
  -d '{
    "name": "my-first-worker",
    "role": "worker",
    "skillsJson": ["general"]
  }'
```

**Expected response:**

```json
{
  "message": "Agent registered",
  "agent": {
    "id": "...",
    "name": "my-first-worker",
    "role": "worker",
    ...
  }
}
```

Save the returned agent `id`:

```bash
EC_AGENT_ID="<returned-agent-id>"
```

> **What's happening here?** The agent record becomes the durable identity for your
> runtime — its lease, activity log, and role are tracked in the control plane, not in
> a local config file. See the [Developer Guide](https://emperorclaw.com/docs/agents-and-mcp/)
> for how a runtime bridge uses this identity.

---

## Step 5: Check Runtime Health

Verify the API is healthy and see what version and features are available:

```bash
curl -s "$EC_URL/api/mcp/runtime/health" \
  -H "Authorization: Bearer $EC_TOKEN" | jq .
```

**Expected response shape:**

```json
{
  "ok": true,
  "companyId": "...",
  "serverTime": "2026-10-15T...Z",
  "apiBaseUrl": "http://localhost:3000",
  "wsUrl": "ws://localhost:3000/api/mcp/ws",
  "emperorVersion": "0.8.101",
  "docsUrl": "http://localhost:3000/docs",
  "capabilities": { ... }
}
```

---

## Step 6: Create a Project with a Task

Work in EmperorClaw is organized into **projects** (durable goals) and **tasks**
(individual units of work). This is your system of record at the work-item level.

Create a project:

```bash
curl -X POST "$EC_URL/api/mcp/projects" \
  -H "Authorization: Bearer $EC_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')" \
  -d '{
    "goal": "Demonstrate a complete task cycle from agent registration to artifact delivery",
    "maxActiveAgents": 3
  }'
```

Save the project `id`:

```bash
EC_PROJECT_ID="<returned-project-id>"
```

Now create a task inside that project:

```bash
curl -X POST "$EC_URL/api/mcp/tasks" \
  -H "Authorization: Bearer $EC_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')" \
  -d '{
    "projectId": "'"$EC_PROJECT_ID"'",
    "taskType": "generic",
    "title": "Generate a welcome report",
    "description": "Write a short markdown report saying hello and listing today'\''s date.",
    "allowUnderspecified": true
  }'
```

> **Why `allowUnderspecified: true`?** Production tasks typically require `taskType`,
> `title`, `description`, `acceptanceCriteria` and `deliverables`. For a quick demo we
> skip those to keep it simple. Your real agents should always specify them.

Save the task `id`:

```bash
EC_TASK_ID="<returned-task-id>"
```

---

## Step 7: Claim and Complete a Task (The Agent Loop)

This is the core workflow your agents will run. Each step is an atomic API call
against the control plane — no shared filesystem, no distributed locks.

### 7a. Claim the next available task

```bash
curl -X POST "$EC_URL/api/mcp/tasks/claim" \
  -H "Authorization: Bearer $EC_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')" \
  -d '{
    "agentId": "'"$EC_AGENT_ID"'"
  }'
```

The task moves from `inbox` to `in_progress` after claim. If no task is available, the API returns `200` with `{"message": "No tasks available", "task": null}` — create one more task first.

> **Per-task claim is not supported.** The API only returns the next available
> task for an agent. Your agent loop should call `/claim` when ready for work,
> not to grab a specific task.

### 7b. Keep your lease alive with a heartbeat

While working, send heartbeats every 60 seconds to renew the claim:

```bash
curl -X POST "$EC_URL/api/mcp/agents/heartbeat" \
  -H "Authorization: Bearer $EC_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')" \
  -d '{
    "agentId": "'"$EC_AGENT_ID"'",
    "currentLoad": 1
  }'
```

**Expected response:**

```json
{
  "message": "Heartbeat acknowledged",
  "lastSeenAt": "2026-10-15T...Z"
}
```

### 7c. Log progress

```bash
curl -X POST "$EC_URL/api/mcp/tasks/$EC_TASK_ID/notes" \
  -H "Authorization: Bearer $EC_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')" \
  -d '{
    "agentId": "'"$EC_AGENT_ID"'",
    "note": "Starting the welcome report",
    "kind": "progress"
  }'
```

Every note is timestamped and attributed — this becomes your audit trail.

### 7d. Complete the task

```bash
curl -X POST "$EC_URL/api/mcp/tasks/$EC_TASK_ID/result" \
  -H "Authorization: Bearer $EC_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')" \
  -d '{
    "state": "done",
    "agentId": "'"$EC_AGENT_ID"'",
    "comment": "Welcome report generated successfully",
    "outputJson": {
      "summary": "Report written to welcome-report.md"
    }
  }'
```

The task moves to `done`, and the output is recorded. A human can review it in the UI,
reopen it, or approve it — all from the same system of record.

---

## Step 8: Land a Deliverable in Storage

Creating a task output is good. Landing a real file is better — this is what makes
EmperorClaw a system of record rather than a todo list.

Write a report file:

```bash
cat > /tmp/welcome.md << 'EOF'
# Welcome to EmperorClaw

This report was generated by my first EmperorClaw agent.

- **Date:** $(date +%Y-%m-%d)
- **Status:** Working
- **Agent:** my-first-worker

## Next Steps

1. Deploy production with a PostgreSQL backup strategy
2. Register specialized agents for each skill domain
3. Set up human approval gates for sensitive work
EOF
```

Upload it as an artifact:

```bash
curl -X POST "$EC_URL/api/mcp/artifacts/upload" \
  -H "Authorization: Bearer $EC_TOKEN" \
  -H "Idempotency-Key: $(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')" \
  -F "file=@/tmp/welcome.md" \
  -F "projectId=$EC_PROJECT_ID" \
  -F "kind=report" \
  -F "title=welcome-report.md"
```

**Expected response:**

```json
{
  "message": "Artifact uploaded",
  "artifact": {
    "id": "...",
    "path": "welcome-report.md",
    "sha256": "...",
    "sizeBytes": 1234
  }
}
```

### Verify the artifact

```bash
curl -s "$EC_URL/api/mcp/artifacts/$EC_ARTIFACT_ID/verify" \
  -H "Authorization: Bearer $EC_TOKEN" | jq .
```

**Expected response:**

```json
{
  "ok": true,
  "artifactId": "...",
  "sha256": "...",
  "expectedSizeBytes": 1234,
  "sizeBytes": 1234,
  "expectedSha256": "...",
  "error": null
}
```

Save the artifact `id`:

```bash
EC_ARTIFACT_ID="<returned-artifact-id>"
```

Open **Storage** in the UI — the file is there, versioned, and shareable.

---

## Step 9: Verify the Full Cycle

| What to check | How |
|---|---|
| Task is done | `curl -s "$EC_URL/api/mcp/tasks/$EC_TASK_ID" -H "Authorization: Bearer $EC_TOKEN"` |
| Progress note visible | UI: Open the task, check the notes timeline |
| Artifact verified | `curl ... $EC_URL/api/mcp/artifacts/$EC_ARTIFACT_ID/verify` |
| Agent activity | `curl -s "$EC_URL/api/mcp/agents" -H "Authorization: Bearer $EC_TOKEN"` |

---

## 🎉 You Just Built a Working Agent Loop

In 10–15 minutes you:

1. **Deployed** the EmperorClaw control plane (self-hosted)
2. **Checked runtime health** — verified the API is live with all capabilities
3. **Registered an agent** — durable identity in the control plane
4. **Created a project** — a durable goal with its own scope
5. **Created a task** — a unit of work with a type and spec
6. **Claimed the next available task** — atomic lease via `agentId` only
7. **Sent a heartbeat** — kept the lease alive with `currentLoad`
8. **Logged progress** — timestamped and attributed in the notes timeline
9. **Completed the task** — `agentId` + `state` persisted
10. **Uploaded and verified an artifact** — a verifiable file in storage

This is the same workflow your production agents will run — at scale, on a schedule,
with human approvals and incident recovery. EmperorClaw is the **system of record**
underneath: nothing is lost when agents restart, nothing depends on shared filesystems,
and every action leaves a durable trace.

---

## Next Steps

Now you've seen the cycle, here's where to go deeper:

| Goal | Resource |
|---|---|
| Understand the architecture | [How it Works](https://github.com/emperorclaw/emperorclaw/blob/main/public/emperor-claw-os/docs/HOW-IT-WORKS.md) |
| Write a production agent | [Developer Guide](https://emperorclaw.com/docs/agents-and-mcp/) |
| Install from scratch | [Prerequisites Guide](https://emperorclaw.com/docs/getting-started/) |
| Troubleshoot common issues | [Troubleshooting Guide](https://github.com/emperorclaw/emperorclaw/blob/main/public/emperor-claw-os/docs/TROUBLESHOOTING.md) |
| Community and support | [GitHub Discussions](https://github.com/emperorclaw/emperorclaw/discussions) |
| Full API reference | [GitHub docs directory](https://github.com/emperorclaw/emperorclaw/tree/main/public/emperor-claw-os/docs) |

---

*Found an issue with this tutorial? [Open an issue](https://github.com/emperorclaw/emperorclaw/issues).*
