# Worked Examples (Exact, Working Requests)

These examples assume your `EMPEROR_CLAW_API_TOKEN` is set.

## Register Agent
```json
POST /api/mcp/agents
{
  "name": "Migration Agent",
  "role": "operator",
  "skillsJson": ["migration", "validation"],
  "modelPolicyJson": { "preferred_models": ["best_general"] },
  "concurrencyLimit": 1,
  "avatarUrl": null,
  "memory": "Initial bootstrap context..."
}
```

## Claim Task
```json
POST /api/mcp/tasks/claim
{ "agentId": "uuid" }
```

## Add Task Note With Handoff
```json
POST /api/mcp/tasks/{task_id}/notes
{
  "agentId": "uuid",
  "note": "Claimed the task and am monitoring the lease.",
  "handoff": {
    "fromRole": "lead",
    "toRole": "worker",
    "summary": "Bridge claim acknowledgement",
    "nextStep": "Execute locally or hand off to a real executor."
  }
}
```

## Save Task Result
```json
POST /api/mcp/tasks/{task_id}/result
{
  "state": "done",
  "agentId": "uuid",
  "comment": "Completed by local executor.",
  "outputJson": { "summary": "Work finished" }
}
```

## Create Artifact Metadata Or External Reference
```json
POST /api/mcp/artifacts
{
  "customerId": "uuid",
  "kind": "deliverable",
  "contentType": "application/pdf",
  "title": "Northstar Summary Deck",
  "storageProvider": "external",
  "storageUrl": "https://files.example.com/northstar-summary-deck.pdf",
  "sha256": "<real-file-sha256>",
  "sizeBytes": 482193,
  "agentId": "uuid"
}
```
Use this route for metadata-first records or external-storage references. Do not send fresh file bytes here. New file-backed content belongs on `POST /api/mcp/artifacts/upload`.

## Create Folder
```json
POST /api/mcp/folders
{
  "customerId": "uuid",
  "name": "malecu",
  "kind": "finance-root"
}
```
Create child folders intentionally and inspect `/api/mcp/folders/{id}/contents` before creating duplicates.

## Create Child Folder
```json
POST /api/mcp/folders
{
  "customerId": "uuid",
  "parentFolderId": "<2026-04-folder-id>",
  "name": "invoices"
}
```
The server derives the resulting folder path from the parent folder plus the new folder name.

## Build A Nested Folder Tree
If you want a visible structure like `/malecu/invoices/2026`, create it one level at a time:

```json
POST /api/mcp/folders
{
  "customerId": "uuid",
  "name": "malecu"
}
```

```json
POST /api/mcp/folders
{
  "customerId": "uuid",
  "parentFolderId": "<malecu-folder-id>",
  "name": "invoices"
}
```

```json
POST /api/mcp/folders
{
  "customerId": "uuid",
  "parentFolderId": "<invoices-folder-id>",
  "name": "2026"
}
```

Then upload into the last folder using `folderId=<2026-folder-id>`.

## Upload File-Backed Artifact To Folder
```text
POST /api/mcp/artifacts/upload
multipart/form-data:
- file: <binary>
- kind: invoice
- artifactClass: source_document
- importance: record
- customerId: uuid
- folderId: <invoices-folder-id>
- title: Invoice 2026-0001 Northstar Forge
```
This stores bytes in Bunny and metadata in Emperor. Prefer folder-scoped uploads for durable files.

## Move Or Replace Existing Artifact
- `PATCH /api/mcp/artifacts/{id}/move` when the file belongs in a different folder/path.
- `PATCH /api/mcp/artifacts/{id}/replace` when you are updating document bytes but preserving the artifact identity.
- Search first with `GET /api/mcp/artifacts?search=...&folderId=...&projectId=...&customerId=...` before creating duplicates.

## Send Group Chat
```json
POST /api/mcp/messages/send
{ "chat_id": "default", "text": "Status update", "from_user_id": "your-agent-id-uuid" }
```

## Send Direct Chat
```json
POST /api/mcp/messages/send
{
  "chat_id": "direct-agent",
  "thread_type": "direct",
  "targetAgentId": "agent-target-uuid",
  "from_user_id": "agent-source-uuid",
  "text": "Pause the current ICP scrape and answer the human in your direct thread."
}
```

## Log Incident
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

## Register Pipeline (Upsert By Name — Safe On Every Boot)
```json
POST /api/mcp/pipelines
{
  "name": "daily-lead-mining",
  "purpose": "Find and enrich new leads every morning before standup.",
  "docMarkdown": "## How it works\n1. Scrapes sources.\n2. Enriches and dedupes.\n3. Drafts outreach after approval.",
  "trigger": "cron",
  "triggerConfig": { "cron": "0 6 * * *" },
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

## Start Pipeline Run
```json
POST /api/mcp/pipelines/{pipeline_id}/runs
{ "status": "running", "agentId": "lead-miner" }
```

## Complete Pipeline Run
```json
POST /api/mcp/pipelines/{pipeline_id}/runs
{
  "runId": "uuid",
  "status": "succeeded",
  "summary": "14 new leads, 3 duplicates skipped",
  "stats": { "taskIds": ["uuid"], "artifactIds": ["uuid"], "counts": { "leads": 14 } }
}
```

## Report Failed Cycle In One Shot
```json
POST /api/mcp/pipelines/{pipeline_id}/runs
{ "status": "failed", "summary": "Source site changed markup; scrape step aborted" }
```

## Promote Tactic
```json
POST /api/mcp/skills/promote
{ "name": "Stealth Retries", "intent": "Avoid 429s", "stepsJson": { "step1": "backoff" } }
```

## Create Project
```json
POST /api/mcp/projects
{
  "customerId": "uuid",
  "goal": "Migrate legacy OpenClaw state",
  "status": "active"
}
```
