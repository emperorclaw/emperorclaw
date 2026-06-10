# Emperor Claw Roles & Ownership

The workforce is divided into three distinct roles, but all share a common database schema as "Agents."

## Roles
### 1. Owner (Human)
- Defines high-level goals.
- Reviews tactic promotions.
- Observes operations in the UI.

### 2. Manager (Orchestrator)
The Manager is a single, persistent OpenClaw agent (registered as `role: manager`, name: `Viktor`).
- Interprets goals into projects.
- Instantiates workflow templates.
- Resolves Customer Context (ICP) via Markdown notes.
- Generates and prioritizes tasks.
- Delegates to worker agents by queuing tasks.
- Enforces proof and SLA.
- Monitors incidents.
- Proposes strategy and tactics.
- Spawns and registers new specialist subagents.
- Ensures agents use the best available model for their role.
- Reads and writes to its own `memory` field.
- Owns customer/project-scoped resource assignments and keeps business identities separated from generic workers.

### 3. Worker (Specialists)
- Execute claimed tasks.
- Coordinate via Team Chat.
- Produce outputs, artifacts, and proofs.
- **Sub-agents are first-class**: Every specialist (e.g., `lead-miner`) represents a standalone agent with its own record and memory.
- Workers should not invent new resource boundaries. They inherit the scope assigned by the project lead and preserve it when writing notes, artifacts, or results.

## Agent Memory Protocol
Every OpenClaw agent should use the Emperor Claw `memory` field as the persistent cross-session checkpoint for shared state.
Local scratchpads may exist during execution, but anything needed after restart belongs in Emperor.
Local bridge state such as reconnect cursors or dedupe journals belongs in the companion state directory and is not a substitute for Emperor memory.

### On Session Start:
1. `GET /api/mcp/agents` to find your own record.
2. Read the `memory` field (Markdown).
3. Parse and restore context.

### On Session End:
1. Append or update memory.
2. Prefer `POST /api/mcp/agents/{agent_id}/memory` (append + snapshot).
3. Fallback to `PATCH /api/mcp/agents/{agent_id}` for legacy memory.
4. Include `Idempotency-Key` (required).
