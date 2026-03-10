---
name: mission-control
description: Kanban-style task management dashboard for AI assistants. Manage tasks via CLI or dashboard UI. Use when user mentions tasks, kanban, task board, mission control, or wants to track work items with status columns (backlog, in progress, review, done).
homepage: https://github.com/rdsthomas/mission-control
metadata: {"clawdbot": {"emoji": "🎛️"}}
---

# Mission Control — Task Management for AI Assistants

A Kanban-style task board that you (the AI assistant) manage. Your human creates and prioritizes tasks via the web dashboard; you execute them automatically when they're moved to "In Progress".

## 🚀 Quick Start

**Just say:** *"Set up Mission Control for my workspace"*

The agent will:
1. Check prerequisites (Tailscale, gh CLI)
2. Copy dashboard files to your workspace
3. Create the config file (`~/.clawdbot/mission-control.json`)
4. Install the webhook transform
5. Set up GitHub webhook
6. Push to GitHub and enable Pages

**That's it.** The agent handles everything.

---

## Prerequisites

Before setup, you need:

| Requirement | Check | Install |
|-------------|-------|---------|
| **Tailscale** | `tailscale status` | `brew install tailscale` or [tailscale.com/download](https://tailscale.com/download) |
| **Tailscale Funnel** | `tailscale funnel status` | `tailscale funnel 18789` (one-time) |
| **GitHub CLI** | `gh auth status` | `brew install gh && gh auth login` |

If any are missing, tell the agent — it will guide you through installation.

---

## How It Works

1. **Dashboard** — Web UI hosted on GitHub Pages where humans manage tasks
2. **Webhook** — GitHub sends push events to Clawdbot when tasks change
3. **Transform** — Compares old vs new tasks.json, detects status changes
4. **Auto-Processing** — When a task moves to "In Progress", the agent starts working

### The Flow

```
Human moves task → GitHub push → Webhook → Transform → Agent receives work order
      ↓                                                         ↓
   Dashboard                                              Executes task
      ↓                                                         ↓
Agent updates status ← Commits changes ← Marks subtasks done ←─┘
```

---

## Task Structure

Tasks live in `<workspace>/data/tasks.json`:

```json
{
  "id": "task_001",
  "title": "Implement feature X",
  "description": "Detailed context for the agent",
  "status": "backlog",
  "subtasks": [
    { "id": "sub_001", "title": "Research approach", "done": false },
    { "id": "sub_002", "title": "Write code", "done": false }
  ],
  "priority": "high",
  "dod": "Definition of Done - what success looks like",
  "comments": []
}
```

### Status Values

| Status | Meaning |
|--------|---------|
| `permanent` | Recurring tasks (daily checks, etc.) |
| `backlog` | Waiting to be worked on |
| `in_progress` | **Agent is working on this** |
| `review` | Done, awaiting human approval |
| `done` | Completed and approved |

---

## CLI Commands

Use `<skill>/scripts/mc-update.sh` for task updates:

```bash
# Status changes
mc-update.sh status <task_id> review
mc-update.sh status <task_id> done

# Comments
mc-update.sh comment <task_id> "Progress update..."

# Subtasks
mc-update.sh subtask <task_id> sub_1 done

# Complete (moves to review + adds summary)
mc-update.sh complete <task_id> "Summary of what was done"

# Push to GitHub
mc-update.sh push "Commit message"
```

---

## Agent Workflow

When you receive a task (moved to "In Progress"):

1. **Read** — Check title, description, subtasks, dod
2. **Mark started** — `mc-update.sh start <task_id>`
3. **Execute** — Work through subtasks, mark each done
4. **Document** — Add progress comments
5. **Complete** — `mc-update.sh complete <task_id> "Summary"`

### Handling Rework

If a completed task is moved back to "In Progress" with a new comment:
1. Read the feedback comment
2. Address the issues
3. Add a comment explaining your changes
4. Move back to Review

---

## EPICs

EPICs are parent tasks with multiple child tickets. When you receive an EPIC:

1. Child tickets are listed in the subtasks (format: `MC-XXX-001: Title`)
2. Work through them sequentially (1 → 2 → 3...)
3. After each child: comment result, set to "review", mark EPIC subtask done
4. After last child: set EPIC to "review"

---

## Heartbeat Integration

Add to your `HEARTBEAT.md`:

```markdown
## Task Check

1. Check `data/tasks.json` for tasks in "in_progress"
2. Flag tasks with `processingStartedAt` but no recent activity
3. Check "review" tasks for new feedback comments
```

---

## Configuration

Config lives in `~/.clawdbot/mission-control.json`. See `assets/examples/CONFIG-REFERENCE.md` for all options.

Minimal config (set by agent during setup):

```json
{
  "gateway": { "hookToken": "your-token" },
  "workspace": { "path": "/path/to/workspace" },
  "slack": { "botToken": "xoxb-...", "channel": "C0123456789" }
}
```

---

## Troubleshooting

See `docs/TROUBLESHOOTING.md` for common issues:

- Dashboard shows sample data → Connect GitHub token
- Webhook not triggering → Check Tailscale Funnel
- Changes not appearing → GitHub Pages cache (wait 1-2 min)

---

## Security

Mission Control is a task management system **for** AI agents — its core purpose is to pass human-authored task descriptions to an agent for execution. This is by design, not a vulnerability.

### Trust Model

- **Single-user / trusted-user setup:** Task authors are the same people who control the agent. The trust boundary is identical to typing a message directly to your assistant.
- **Multi-user setups:** If multiple users can create tasks on the dashboard, treat task content as untrusted input. Use Clawdbot's agent sandbox and permission model to limit what the agent can do.

### Mitigations

- **Input sanitization:** `mc-update.sh` validates all inputs against injection patterns before passing them to Python or git.
- **No credential storage:** The dashboard stores no tokens or secrets — all auth is handled by Clawdbot's config.
- **Webhook HMAC verification:** The transform module validates webhook signatures using `timingSafeEqual` to prevent tampering.
- **Security scan on sync:** The `sync-to-opensource.sh` script scans for leaked credentials before publishing.

### Recommendations

- Keep your dashboard repository **private** if you don't want others to see your task data.
- Review task descriptions before moving them to "In Progress" if the task was created by someone else.
- Use Clawdbot's `groupPolicy` and `allowFrom` settings to restrict who can interact with the agent.

---

## Files

| File | Purpose |
|------|---------|
| `<workspace>/index.html` | Dashboard UI |
| `<workspace>/data/tasks.json` | Task data |
| `<skill>/scripts/mc-update.sh` | CLI tool |
| `~/.clawdbot/mission-control.json` | Config |
| `~/.clawdbot/hooks-transforms/github-mission-control.mjs` | Webhook transform |
