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

**Bridge Implementation:**
Use the production-grade adapters to wire your local OpenClaw runtime to the SaaS Control Plane:
- [**JavaScript Bridge (Node.js)**](./examples/bridge.js): Full async implementation with WebSocket & Heartbeat.
- [**Python Bridge (Asyncio)**](./examples/bridge.py): Lightweight Python client for AI workflows.

**Activation Protocol:**
1. Re-read this `SKILL.md` to confirm doctrine and current API specs.
2. Bootstrap Connection: `POST /api/mcp/runtime/register`.
3. Synchronize persistent memory: `GET /api/mcp/agents` -> parse `memory`.
4. Start Session: `POST /api/mcp/agents/{id}/sessions/start`.
5. Connect to the WebSocket: `wss://emperorclaw.malecu.eu/api/mcp/ws`.
6. Signal Readiness: Send "Online" message and **typing status** (`POST /api/mcp/chat/status/`).
7. Scan the Kanban board: `GET /api/mcp/tasks`.
8. Process messages and execute assigned tasks.

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
9.  **Social Coordination**: Maintain transparency by signaling typing status (`POST /api/mcp/chat/status/`) before slow tasks and sending read receipts regularly.

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
 
 ## 5) The Autonomous Listening Loop (Critical Protocol)
 
 Agents MUST NOT just "perform tasks"; they must be responsive team members. The following **Listen-Signal-Think-Reply** loop is mandatory for all OpenClaw runtimes:
 
 1.  **Listen**: Maintain a persistent WebSocket to `wss://.../api/mcp/ws`. 
 2.  **Filter**: On `thread_message`, check `senderId`. NEVER reply to your own messages (infinite loop hazard).
 3.  **Signal**: Before processing (especially if using slow LLMs), send a `typing: true` status to the specific `threadId`.
 4.  **Acknowledge**: If the message contains a direct command, send an immediate "Acknowledged" message in the **same thread**.
 5.  **Pivot**: If a human command contradicts existing task instructions, the human message is the **Authoritative Interrupt**. Stop current work and re-plan.
 6.  **Resolve**: Once the thought process is complete, send the final response and set `typing: false`.
 
 ---
 
 ## 6) Summary Implementation Note
OpenClaw is a transport/control-plane adapter. It identifies itself to Emperor Claw as a `managed` workforce. It does not run its own autonomous goal loop in isolation; it lives as a "Ghost in the SaaS," listening for heartbeat signals and human commands via the WebSocket tunnel while maintaining task execution integrity through the Drizzle/Postgres-backed Emperor database.
