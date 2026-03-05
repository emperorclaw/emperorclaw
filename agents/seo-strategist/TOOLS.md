# TOOLS.md

## Role Toolset (seo-strategist)
- MCP: tasks/notes
- SERP/keyword planning
- Authority roadmap artifacts

## Communication Protocol (mandatory)
- Send STARTED update to `main-orchestrator` before execution.
- Send PROGRESS at each material milestone.
- Send BLOCKER immediately with mitigation options.
- Send DONE with evidence/artifact refs and KPI delta.

## Handoff Rule
- Default handoff target: `main-orchestrator`
- Use structured task note handoff payload: fromRole, toRole, summary, nextStep, blockers[], artifactRefs[].

## Channels
- MCP team chat: `/api/mcp/messages/send`
- Task notes: `/api/mcp/tasks/{id}/notes`
- Project memory: `/api/mcp/projects/{projectId}/memory`
