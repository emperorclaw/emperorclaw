# Emperor Web v0.1.2

Emperor Web is the control‑plane UI and API for coordinating AI agents, projects, and resources. This version introduces **Force Sharing injection**, **agent‑scoped resources**, and **bridge‑side context injection**.

## What’s New in v0.1.2

- **`isShared` resource injection** – Resources marked as “Force Sharing” (`isShared: true`) are automatically injected into agent prompts **in every message**, not just when resources are requested.
- **Agent‑scoped resources** – Resources can be scoped to specific agents (`scopeType: "agent"`) for private credentials, agent profiles, and personal context.
- **Bridge‑side force‑sharing** – The bridge now includes a `getForceSharedResourcesForAgent()` function that always injects force‑shared resources with proper scope filtering.
- **API improvements** – `POST /api/mcp/resources` accepts `scopeType` and `scopeId` fields for creating agent‑scoped resources (also supports legacy `agentId` field).
- **Agent‑to‑agent communication** – Agents can reply to each other when explicitly `@mentioned`.
- **Sync‑loop disabled by default** – The bridge relies on WebSocket events instead of periodic polling.
- **CLI‑style installer** – Installation script accepts flags (`--agent-name`, `--profile`) and respects environment overrides.

## Core Concepts

### Control‑Plane vs Execution
- **Emperor Web** – Coordination, notification, shared state, durable checkpoints.
- **OpenClaw agents** – Execution body (tools, browser, code, files, skills).

### Resources & Force Sharing
- **Scoped resources** belong to companies, customers, projects, or agents (handbooks, templates, identities, mailboxes, credentials).
- **Force Sharing** (`isShared=true`) overrides standard access policies and injects resource content into agents based on scope:
  - **Company‑scoped** → Injected to all agents
  - **Agent‑scoped** → Injected only to that specific agent
  - **Customer/Project‑scoped** → Injected when agent is working in that context
- **Bridge injection** – The bridge always injects force‑shared resources in the system prompt, not just when the agent asks about resources.

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
                ├── Fetches all resources
                ├── Filters by scope (company/agent/customer/project)
                ├── Injects force‑shared resources into every prompt
                └── Routes to OpenClaw agents
```

The bridge runs as a systemd user service and connects your local OpenClaw agents to the Emperor cloud. It maintains agent‑specific state and ensures force‑shared resources are always available to agents.

## Artifact Storage

- **Bunny-backed blobs** – Artifact content (files, PDFs, spreadsheets) is now stored in Bunny CDN. Emperor only keeps metadata, indexing, permissions, and search while every Bunny key follows `companies/<companyId>/artifacts/<logical-path>`.
- **Folder tree UI** – Emperor Web exposes a folder tree that mirrors Bunny object prefixes. Agents and humans navigate via breadcrumbs, search, and drag/drop uploads; the UI keeps the tree, folders, and artifacts synchronized with the MCP metadata.
- **Finance folders** – The `malecu` finance workspace lives under `artifacts/malecu/YYYY/YYYY-MM/{expenses,invoices,statements}` so reports upload to canonical paths, enabling consistent billing/reporting references.
