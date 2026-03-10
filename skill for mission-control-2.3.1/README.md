# Mission Control

[![Agent-Powered Setup](https://img.shields.io/badge/Setup-Agent--Powered-brightgreen)](https://github.com/rdsthomas/mission-control)
[![Clawdbot Skill](https://img.shields.io/badge/Clawdbot-Skill-blue)](https://clawdhub.com)

A Kanban-style task management system for AI assistants. Your human creates and prioritizes tasks via a web dashboard; the agent executes them automatically when moved to "In Progress".

## Quick Start

**Just say:** *"Set up Mission Control for my workspace"*

The agent handles everything automatically:
- Checks prerequisites (Tailscale, gh CLI)
- Copies dashboard files
- Creates config
- Installs webhook transform
- Sets up GitHub webhook
- Deploys to GitHub Pages

## Features

- 📋 **Kanban Board** — Backlog, In Progress, Review, Done columns
- 🔄 **Auto-Execution** — Agent starts working when tasks are moved to "In Progress"
- 🎯 **EPIC Support** — Parent tasks with multiple child tickets
- 💬 **Comments** — Track progress and feedback
- 📊 **Subtasks** — Break complex tasks into steps
- 🔔 **Slack Notifications** — Optional status updates

## Documentation

- [SKILL.md](SKILL.md) — Full skill reference
- [docs/PREREQUISITES.md](docs/PREREQUISITES.md) — Installation requirements
- [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) — Technical architecture
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — Common issues & solutions

## Requirements

| Tool | Check | Purpose |
|------|-------|---------|
| Tailscale | `tailscale status` | Secure tunnel for webhooks |
| Tailscale Funnel | `tailscale funnel status` | Expose Clawdbot to internet |
| GitHub CLI | `gh auth status` | Repository operations |

## Configuration

Config lives in `~/.clawdbot/mission-control.json`. See [CONFIG-REFERENCE.md](assets/examples/CONFIG-REFERENCE.md) for all options.

## CLI Usage

```bash
# Update task status
mc-update.sh status <task_id> review

# Add comment
mc-update.sh comment <task_id> "Progress update..."

# Complete task
mc-update.sh complete <task_id> "Summary of what was done"
```

## How It Works

1. Human moves task to "In Progress" in dashboard
2. GitHub sends webhook to Clawdbot
3. Transform detects status change
4. Agent receives work order
5. Agent executes task, updates status
6. Human reviews and approves

## Security

Mission Control passes human-authored task descriptions to an AI agent for execution. This is the product's core function — not a vulnerability.

**Trust model:** Designed for single-user / trusted-user setups where the task author is the same person who controls the agent. For multi-user scenarios, use Clawdbot's agent sandbox and permission settings.

**Mitigations included:**
- Input sanitization in `mc-update.sh` (blocks shell injection patterns)
- Webhook HMAC verification with `timingSafeEqual`
- Credential scanning before open-source sync
- No tokens or secrets stored in the dashboard

See [SKILL.md](SKILL.md#security) for full details.

## License

MIT
