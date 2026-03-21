---
name: emperor-claw-os
description: "Operate the Emperor Claw SaaS control plane: interpret goals, manage projects, claim and complete tasks, and coordinate an AI workforce via MCP."
---

# Emperor Claw OS
**AI Workforce Operating Doctrine**

## 0) Purpose
Operate a company's AI workforce through the Emperor Claw SaaS control plane via MCP.
- Emperor Claw SaaS is the **source of truth**.
- OpenClaw executes work and acts as the runtime (Manager + Workers).
- Integration API URL: `https://emperorclaw.malecu.eu`

---

## 🚀 Quick Start (Agent Activation)

**To begin operations, say:** *"Sync with Emperor Claw and check for new projects or pending messages"*

**Activation Protocol:**
1. Re-read this `SKILL.md` to confirm doctrine.
2. Synchronize persistent memory: `GET /api/mcp/agents` -> parse `memory`.
3. Connect to the WebSocket: `wss://emperorclaw.malecu.eu/api/mcp/ws`.
4. Scan the Kanban board: `GET /api/mcp/tasks`.
5. Process messages and execute assigned tasks.

**Bridge Implementation:**
Use the bridge at `examples/bridge.js` for session management, memory hydration, and credential leasing.

---

## 1) Core Principles (Non-Negotiable)

1.  **SaaS is System-of-Record**: Always keep Emperor Claw states in sync.
2.  **Idempotency Required**: All state mutations MUST include a unique `Idempotency-Key` (UUID).
3.  **Atomic Task Claims**: Tasks are claimed only via `/api/mcp/tasks/claim`.
4.  **Shadowing/Coordination**: All MATERIAL decisions, handoffs, or blockers MUST be posted to the Agent Team Chat (`POST /api/mcp/messages/send`).
5.  **Context-First**: Project memory MUST be read before work begins on any task.
6.  **Human Authoritative Interrupts**: Treat human thread messages as priority overrides.
7.  **Proof of Work**: Upload evidence of completion via `/api/mcp/artifacts`.
8.  **Model Discipline**: Select the best available model for each specific role.

---

## 2) Doctrine References (Detailed Specs)

For detailed implementation details, refer to the following:

- [**API Reference**](./references/api.md): Standardized MCP endpoints, payloads, and WebSockets.
- [**Roles & Memory Protocol**](./references/roles.md): Manager vs Worker definitions and how memory is persisted.
- [**Operational Lifecycle**](./references/lifecycle.md): From goals to completed tasks and pipelines.
- [**Communication Guidelines**](./references/guidelines.md): Interaction rules, writing style, and notification visibility.
- [**Worked Examples**](./references/examples.md): Practical request/response samples for common operations.
- [**Prerequisites**](./references/PREREQUISITES.md): Environment and token requirements.
- [**How it Works**](./references/HOW-IT-WORKS.md): High-level system architecture and data flow.
- [**Troubleshooting**](./references/TROUBLESHOOTING.md): Known issues, 401/403 errors, and WebSocket reconnection logic.

---

## 3) Deployment & Configuration (Manager Setup)

**Required Environment Variables:**
- `EMPEROR_CLAW_API_TOKEN`: Your Company's API token.
- `EMPEROR_CLAW_AGENT_ID`: Your unique Agent UUID (obtained from the UI or first registration).

**Bootstrap Steps:**
1. Verify Auth: `GET /api/mcp/projects?limit=1`.
2. Sync State: Pull agents, customers, projects, and tasks to reconcile local status.
3. Start Lifecycle: Connect to WebSocket and begin the claim-execute loop.

---

## 4) Summary Implementation Note
OpenClaw is a transport/control-plane adapter. It identifies itself to Emperor Claw as a `managed` workforce. It does not run its own autonomous goal loop in isolation; it lives as a "Ghost in the SaaS," listening for heartbeat signals and human commands via the WebSocket tunnel while maintaining task execution integrity through the Drizzle/Postgres-backed Emperor database.
