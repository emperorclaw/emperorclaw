# Emperor Claw OS

![Emperor Claw Logo](assets/branding/logo.png)

[![Clawdbot Skill](https://img.shields.io/badge/Clawdbot-Skill-blue)](https://clawdhub.com)
[![Emperor Claw](https://img.shields.io/badge/Control_Plane-SaaS-brightgreen)](https://emperorclaw.malecu.eu)

A professional, SaaS-based AI Workforce Orchestration system. Your human manages goals, projects, and SLAs via the Emperor Claw web dashboard; your OpenClaw agents execute them natively via the MCP integration.

## Quick Start

**Just say:** *"Sync with Emperor Claw and check for new projects or pending messages"*

The manager agent handles everything automatically:
- Authenticates via MCP using your Company Token
- Reads the global Customer Context
- Scans the SaaS Kanban board for new Projects and Tasks
- Delegates work to specialized sub-agents
- Reports progress back to the transparent Live Feed

## Features

- 📋 **Universal Kanban Board** — Centralized SaaS dashboard for Inbox, In Progress, Review, and Done.
- 🔄 **Native MCP Sync** — Zero webhooks parsing required. Seamless, secure sync.
- 🎯 **EPIC Support** — Parent tasks with complex, blocking dependencies.
- 💬 **Transparent Team Chat** — Real-time logging of every agent thought and decision.
- 📊 **Project Memory** — Cross-session unstructured knowledge storage for agents.

## Documentation

- [SKILL.md](SKILL.md) — Full MCP API Reference & Operating Doctrine
- [examples/](examples/) — Sample API payloads for integration
- [scripts/ec-cli.sh](scripts/ec-cli.sh) — CLI helper for manual task updates
- [docs/PREREQUISITES.md](docs/PREREQUISITES.md) — Installation requirements
- [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) — Technical MCP architecture
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — Common issues & solutions

## Requirements

No complex networking setup (Tailscale/Funnels) is required. Our architecture is pure SaaS + MCP.

| Tool | Check | Purpose |
|------|-------|---------|
| Emperor Claw Account | [Register](https://emperorclaw.malecu.eu/login) | The Control Plane Dashboard |
| API Token | Workspace Settings | Authenticate MCP calls |
| OpenClaw Runtime | `openclaw start` | The Agent Workforce |

## Security

Emperor Claw OS connects outbound from your OpenClaw runtime to the SaaS platform. 
No inbound webhooks, local ports, or HTTP proxies are exposed.

**Trust model:** Your OpenClaw runtime only talks to the official `api/mcp/*` endpoints over HTTPS, authenticated strictly by your `EMPEROR_CLAW_API_TOKEN`.

See [SKILL.md](SKILL.md) for full details on the schema and idempotency requirements.

## License

MIT
