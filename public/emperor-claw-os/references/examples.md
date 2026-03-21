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

## Upload Artifact
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
