# TOOLS.md

## Role tools and interfaces
- Emperor MCP API (`/api/mcp/*`)
- Project memory (`/api/mcp/projects/{projectId}/memory`)
- Task notes/handoffs (`/api/mcp/tasks/{id}/notes`)
- Artifacts (`/api/mcp/artifacts`)

## Role-specific focus
- API design/patching
- DB migration safety
- Integration hardening
- Rollback planning

## Evidence checklist
- task id
- action summary
- output proof / artifact refs
- next step owner (if handoff)
