# Emperor Claw: Hermes Plugin and Bridge

Connect [Hermes Agent](https://github.com/NousResearch/hermes-agent) runtimes to the [Emperor Claw](https://emperorclaw.malecu.eu) AI agent control plane.

This folder holds two components:

| Component | What it does |
| --- | --- |
| **Plugin** (`__init__.py`, `plugin.yaml`, `operating-guide.md`, `skills/`) | Registers Emperor Claw tools inside a Hermes profile so agents can read and write control-plane state |
| **Bridge 0.9** (`bridge/emperor_bridge/`) | Long-running service that picks up Emperor messages, submits them to the agent's Hermes gateway, streams live steps back, and sends replies |

Do not copy these files by hand. Remote hosts install them with the `emperor-hermes` installer, and Emperor's managed Docker image ships them for local agents.

---

## How it fits together

```
Emperor Claw (control plane)
   |  messages, tasks, projects; live steps and run ledger back
   v
emperor-hermes-bridge@<agent>       python -m emperor_bridge, on Hermes' own Python
   |  local gateway socket + WebSocket (hermes-gateway-v1)
   v
emperor-hermes-gateway@<agent>      Hermes v0.22.4 gateway, warm sessions per Emperor thread
   |  tools
   v
Emperor Claw plugin                 emperor_health, emperor_list_tasks, ...
```

Emperor owns the durable state: tasks, projects, threads, artifacts, resources, audit log. Hermes is the local runtime that thinks and acts. The bridge is the glue between them.

---

## Install on a remote host

Requirements: Linux with systemd user units, `curl`, `git`, `tar`, `python3`, lingering enabled, and an Emperor agent token per agent.

```bash
mkdir -p ~/.local/bin
curl -fsSL https://github.com/emperorclaw/emperorclaw/releases/download/v0.9.3/emperor-hermes.sh -o ~/.local/bin/emperor-hermes
chmod +x ~/.local/bin/emperor-hermes

emperor-hermes doctor --plan --profiles viktor,katarina   # does the host fit?
emperor-hermes install --profile viktor,katarina          # Hermes v0.22.4, bridge, plugin, units
emperor-hermes status
```

Each profile's `.env` (`~/.hermes/profiles/<profile>/.env`) holds the agent's settings:

```bash
EMPEROR_CLAW_API_URL="https://emperorclaw.malecu.eu"
EMPEROR_CLAW_API_TOKEN="<agent token>"
EMPEROR_CLAW_AGENT_ID="<emperor-agent-id>"
EMPEROR_CLAW_AGENT_NAME="Viktor"
EMPEROR_CLAW_HERMES_TOOLSETS="emperor-claw,web,terminal,code_execution"
DEEPSEEK_API_KEY="<model provider key>"
```

`emperor_request` is scoped to Emperor MCP endpoints. For external HTTP calls (Stripe, GitHub, ...), include `terminal` in the toolsets and use `curl`, or install a dedicated plugin.

Upgrading from the 0.3 bridge (`emperor_hermes_bridge.py`)? Run `emperor-hermes migrate --all`. The full guide, including rollback and small machines, is in the docs: **Migrating Hermes Agents to 0.9**. Day-to-day operation is in **Hermes Agent Runtime**.

---

## Agent mapping

One Emperor agent, one Hermes profile, one gateway, one bridge.

| Emperor agent | Hermes profile | Units |
| --- | --- | --- |
| Viktor | `viktor` | `emperor-hermes-gateway@viktor`, `emperor-hermes-bridge@viktor` |
| Katarina | `katarina` | `emperor-hermes-gateway@katarina`, `emperor-hermes-bridge@katarina` |

Low-memory hosts can opt into one shared gateway and bridge for all agents (`emperor-hermes install --gateway shared`), with the isolation trade-off described in the migration guide.

---

## Developing

- Package the bridge bundle the installer consumes: `scripts/package-hermes-bridge.sh` (writes `dist/hermes-bridge/`).
- Installer end-to-end test (Docker, systemd user units, mocked Hermes): `bash tests/hermes-installer.test.sh`.
- Gateway protocol harness: `tests/contract/hermes/`.

---

## Tools Provided

| Tool | Description |
| --- | --- |
| `emperor_health` | Check Emperor MCP runtime health |
| `emperor_request` | Generic Emperor MCP REST call (Emperor endpoints only, not external APIs) |
| `emperor_list_projects` | List Emperor projects |
| `emperor_create_project` | Create an Emperor project |
| `emperor_list_tasks` | List tasks, filtered by project or state |
| `emperor_list_threads` | List direct, team, group, project, task, or incident threads |
| `emperor_get_thread_messages` | Read exact message history for a thread |
| `emperor_add_task_note` | Add a progress, blocker, or handoff note to a task |
| `emperor_send_message` | Send a message into a direct, team, or group thread |
| `emperor_list_groups` | List your group chats (members-only team channels) with purpose and members |
| `emperor_create_group` | Create a group chat for a set of agents and humans; you join it |
| `emperor_add_group_members` | Add agents or humans to a group you belong to |
| `emperor_remove_group_member` | Remove an agent or human from a group you belong to |

The operating guide (`operating-guide.md`) is part of each agent's session instructions, and the plugin also registers it as a skill.

### Where agents should look

| Need | Use |
| --- | --- |
| Past chat or exact message history | `emperor_list_threads`, then `emperor_get_thread_messages` |
| Current team roster | `emperor_request` with `GET /agents` |
| Project list or project details | `emperor_list_projects`, or `emperor_request` with `GET /projects/{id}` |
| Task list or task details | `emperor_list_tasks`, or `emperor_request` with `GET /tasks/{id}` |
| Task progress, blockers, notes, handoffs | `emperor_request` with `GET /tasks/{id}/notes` |
| Project memory, assumptions, decisions | `emperor_request` with `GET /projects/{id}/memory` |
| Knowledge & Rules | `emperor_request` with `GET /resources/context`, `GET /resources`, or `POST /resources` |
| Storage files, deliverables, reports, evidence | `emperor_request` with `GET /artifacts` |
| External APIs or websites | terminal/curl, web, or a dedicated plugin; not `emperor_request` |

### Company Brain note shape

Knowledge & Rules should be written like a shared Obsidian-style company vault. Agents should create or propose structured markdown notes, not chat transcripts.

```markdown
---
scope: project
type: project-rule
status: active
owner: <agent-name>
tags:
  - project/example
  - implementation
---

# Project Build Rules

Short summary of the reusable rule.

## Rule

- Durable instruction one.
- Durable instruction two.

## Evidence

- Task: `<task-id>`
- Artifact: `<artifact-id or Storage path>`

## Related

- [[Company Operating Doctrine]]
```

Use scope fields for placement in the vault tree. Do not fake folders in note titles. Use `[[wikilinks]]` to connect notes and frontmatter `tags` for retrieval.

### Messaging model

Emperor has two chat surfaces:

- **Direct threads** are private one-human-to-one-agent inboxes.
- **Team chat** is the shared visible coordination thread for humans and all agents.

In team chat, `@AgentName` is the routing signal. Agents can talk to other agents by posting a visible team message such as `@Viktor please review TASK-12345678 and leave a blocker note if needed`.

Conversation history is REST-readable. Use `emperor_list_threads` to find the thread, then `emperor_get_thread_messages` to read exact messages. Do not tell users that Emperor message history is unavailable or WebSocket-only.

Use `emperor_request` with `GET /agents` to discover the current agent roster. Use `emperor_send_message` with `threadType=team` for visible handoffs, and include `@AgentName` only when you want that agent to act or reply. Group chats work the same way for their members only; post with the group id as `threadId`. A human's `@all` in a group addresses every member; agents never post `@all`.

---

## Emperor Data Semantics

| Emperor UI term | API term |
| --- | --- |
| Knowledge & Rules | `resources` |
| Storage | `artifacts` |
| Chat threads | `messages` |

- Use `resources` for reusable business rules, SOPs, customer facts, templates, credentials metadata.
- Prefer `POST /resources` with frontmatter `status: active` for agent-generated durable knowledge by default; use `status: draft` only when the agent is explicitly uncertain.
- Use `artifacts` for deliverables, reports, exported files, evidence, working documents.
- Use task notes for progress, blockers, handoffs, and execution observations.
- Fetch Emperor state lazily - never preload all projects/tasks at session start.
- Call Emperor tools before reporting a state change, not after.

---

## License

MIT
