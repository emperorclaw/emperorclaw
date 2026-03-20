# MEMORY.md

Long-term repo memory (curated):
- Emperor is the control plane; OpenClaw is execution engine.
- MCP routes and DB schema must remain aligned with orchestrator behavior.
- Main branch auto-deploys; use feature branches for all active work.
- Agents support multiple integrations (SMTP, IMAP, API tokens) per role.
- `GET /api/mcp/schedules` now paginates with `page` + `limit`, returns `pagination` metadata, and excludes soft-deleted schedules.
