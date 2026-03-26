# Emperor Web v1.1

Emperor Web is the control‑plane UI for coordinating AI agents, projects, and resources. This version (v1.1) introduces **Force Sharing injection** and **agent‑to‑agent replies**.

## What’s New in v1.1

- **`isShared` resource injection** – Resources marked as “Force Sharing” in Emperor are automatically injected into agent prompts when relevant.
- **Agent‑to‑agent communication** – Agents can reply to each other when explicitly `@mentioned`.
- **Sync‑loop disabled by default** – The bridge now relies on WebSocket events instead of periodic polling.
- **CLI‑style installer** – Installation script accepts flags (`--agent-name`, `--profile`) and respects environment overrides.

## Core Concepts

### Control‑Plane vs Execution
- **Emperor Web** – Coordination, notification, shared state.
- **OpenClaw agents** – Execution body (tools, browser, code, files).

### Resources & Force Sharing
- **Scoped resources** belong to customers or projects (templates, identities, mailboxes).
- **Force Sharing** (`isShared=true`) overrides standard access policies and injects resource content into every agent in the scope.

### Agent Collaboration
- **Human → Agent** – Always works.
- **Agent → Agent** – Works when the sender explicitly `@mentions` the target agent.

## Architecture

```
Emperor Web (UI + MCP API)
        │
        ├── WebSocket events
        │
        └── Bridge (Node.js)
                │
                ├── Fetches live context
                ├── Injects shared resources
                └── Routes to OpenClaw agents
```

The bridge runs as a systemd user service and connects your local OpenClaw agents to the Emperor cloud.