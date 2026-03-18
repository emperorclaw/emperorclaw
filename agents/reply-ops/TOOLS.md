# TOOLS.md

## Role Toolset (reply-ops)
- MCP: tasks/notes
- Reply triage + follow-up
- Hot-lead escalation logs

## Required Integrations
- Fetch active integration credentials via `GET /api/mcp/agents/{agentId}/integrations` before executing.
- Requires `provider: email_imap` to read incoming messages for the active project.
- Requires `provider: email_smtp` to send follow-up replies on behalf of the customer.

## Communication Protocol (mandatory)
- Send STARTED update to `main-orchestrator` before execution.
- Send PROGRESS at each material milestone.
- Send BLOCKER immediately with mitigation options.
- Send DONE with evidence/artifact refs and KPI delta.

## Handoff Rule
- Default handoff target: `comms-reporter`
- Use structured task note handoff payload: fromRole, toRole, summary, nextStep, blockers[], artifactRefs[].

## Channels
- MCP team chat: `/api/mcp/messages/send`
- Task notes: `/api/mcp/tasks/{id}/notes`
- Project memory: `/api/mcp/projects/{projectId}/memory`
