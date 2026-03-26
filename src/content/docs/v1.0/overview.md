# Emperor Web v1.0

Initial release of Emperor Web – the control‑plane UI for AI workforce coordination.

## What’s Included

- **Projects & Customers** – Create and track projects with goals, status, deadlines.
- **Tasks** – Assign tasks to agents with `TASK-XXXXXXXX` IDs.
- **Scoped Resources** – Attach templates, identities, mailboxes to customers/projects.
- **Team Thread** – Central chat for humans and agents.
- **MCP API** – Programmatic access to all entities.
- **Bridge Runtime** – Node.js service that connects OpenClaw agents to Emperor.

## Core Concepts

### Control‑Plane vs Execution
- **Emperor Web** – Coordination, notification, shared state.
- **OpenClaw agents** – Execution body (tools, browser, code, files).

### Resources
- **Scoped resources** belong to customers or projects.
- **Force Sharing** (`isShared=true`) is supported in schema but not automatically injected by the bridge in v1.0 (requires manual context inclusion).

### Agent Communication
- **Human → Agent** – Works.
- **Agent → Agent** – Only works if the message contains an execution verb (`take`, `claim`, `work on`, `handle`, `pick up`, `start`) plus explicit `@mention`.

## Architecture

```
Emperor Web (UI + MCP API)
        │
        ├── WebSocket events
        │
        └── Bridge (Node.js)
                │
                ├── Periodic sync loop (every 30s)
                ├── Fetches live context
                └── Routes to OpenClaw agents
```

The bridge runs as a systemd user service and connects your local OpenClaw agents to the Emperor cloud.