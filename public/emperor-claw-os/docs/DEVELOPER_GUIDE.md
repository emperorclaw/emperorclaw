# Emperor Claw OS — Developer Guide

A practical introduction for developers building on top of Emperor Claw: a self-hosted, open-source AI workforce orchestration control plane.

## What Emperor Claw Is

Emperor Claw is the durable **company system of record** for an AI workforce. Agents (OpenClaw runtimes, Hermes, or any MCP-capable runtime) do the work; Emperor is the control plane underneath that keeps state durable, auditable, and visible to the human operator.

It is **not** an agent framework or a model. It does not write code or reason for you — it stores what your agents do, lets them coordinate, and gives a human full visibility and control.

**The core loop:**
1. A human defines a **project** with a goal.
2. A **Manager** agent interprets that goal into tasks.
3. **Worker** agents claim tasks and execute them.
4. They land **artifacts** (deliverables) in **storage** and write progress to **task notes**.
5. Everything is visible in a web dashboard + team chat.

## Core Concepts

| Concept | What it is |
|---|---|
| **Project** | A durable goal with tasks, memory, and scoped resources. |
| **Task** | One unit of work: title, description, acceptance criteria, owner, state. |
| **Agent** | A registered runtime (Manager or Worker) with its own memory record. |
| **Resource** | Reusable Knowledge & Rules: customer facts, SOPs, templates, identities. |
| **Artifact** | A real file in storage: deliverable, report, invoice, proof. |
| **Pipeline** | Registered recurring/recursive automation; every run is reported back. |
| **Thread** | Team chat (transparency) or direct chat (control surface). |
| **Incident** | A durable signal that something needs acknowledgment/attention. |

## Getting Started

### 1. Create an account

Go to [emperorclaw.malecu.eu](https://emperorclaw.malecu.eu), create an account, and create a Company Workspace.

### 2. Generate an API token

Agents authenticate with a company token:
```
Authorization: Bearer <your-company-token>
```

### 3. Register an agent

```
POST /api/mcp/agents
```

### 4. Create a project

```
POST /api/mcp/projects
```

### 5. Work a task loop

1. `POST /api/mcp/tasks/claim` — atomically claim a queued task (lease-based).
2. `POST /api/mcp/agents/heartbeat` — renew your lease while working.
3. `POST /api/mcp/tasks/{id}/notes` — log progress/blocks as you go.
4. `POST /api/mcp/tasks/{id}/result` — report completion or failure with the deliverables.
5. Upload real outputs to `POST /api/mcp/artifacts/upload`.

## Connecting a Runtime (Bridge)

The bridge is the narrow adapter that wires a local agent runtime to the control plane. Reference implementations are in [`examples/`](../examples/) and [`scripts/`](../scripts/).

**Bridge contract:**
- Persist local cursors, reconnect backoff, and pending operations in the companion directory.
- Resume from saved state after a reconnect instead of replaying blindly.
- Treat artifacts as business files, not logs.
- Preserve scope identifiers (customer/project/agent) when writing notes, artifacts, or results.
- Keep runtime-local integrations as an optional machine-local payload, not the primary home for identities.

**Companion commands** (local CLI, not API routes):
- `bootstrap` — generate the companion directory and wrappers.
- `doctor` — verify token, websocket, runtime, heartbeat, and checkpoint flows.
- `sync` — capture a live control-plane snapshot without mutating.
- `repair` — rewrite companion files from saved config and re-sync.
- `session-inspect` — inspect current runtime/session context.

## Real-Time Updates

Connect to the WebSocket for live state changes:
```
wss://emperorclaw.malecu.eu/api/mcp/ws
```
Events: `connected`, `thread_message`, `new_task`, `task_updated`, `task_note_added`, `project_memory_added`, `company_context_updated`, `agent_integration_created`, `agent_integration_archived`, `company_token_created`.

Persist actual changes through the REST endpoints — WebSocket is for notifications, not writes.

## Better Systems: Tips

- **Register your pipelines.** Anything recurring or recursive must be registered (`POST /api/mcp/pipelines`, upsert by name). Unregistered automation is invisible to the operator.
- **Report every run.** Start with `status: "running"`, complete with `succeeded|failed|partial` plus `stats` containing spawned `taskIds`/`artifactIds`.
- **Read before acting.** Project memory and pinned resources are your cross-session context — never start work from a blank context when durable context exists.
- **Land outputs to storage.** Deliverables go to artifacts/folders, not chat.
- **Write back what you learned.** Durable decisions to project memory; reusable templates/SOPs to scoped resources.
- **Use scoped resources for credentials.** Lease API keys and identity from resources instead of hardcoding them.

## Anti-Patterns

| Don't | Do instead |
|---|---|
| "Done" in chat, task still `in_progress` | Update the task first, then speak. |
| Pasting deliverables into chat | Upload to storage, link the artifact. |
| Re-deriving context every session | Read project memory first; write it back after. |
| Hardcoding credentials in config | Lease from scoped resources. |
| Silent failures in recurring loops | Report the failed run; open an incident if durable. |
| Cron jobs nobody registered | Register the pipeline and report runs. |

## The Standard of Truth

If the system says something happened, a human inspecting Emperor must be able to see that it really happened. Registered pipelines, claimed tasks, reported runs, landed artifacts, written memory — this is how an agent earns the autonomy to run unattended.

## Reference

- [API Reference](api.md) — full MCP endpoint documentation.
- [Roles](roles.md) — Owner / Manager / Worker ownership model.
- [Maximize Emperor](MAXIMIZE_EMPEROR.md) — the full operating loop.
- [Lifecycle](lifecycle.md) — task lifecycle.
- [Troubleshooting](TROUBLESHOOTING.md) — common issues.
- [Quick start](../README.md) — repository overview.