# Emperor Claw — Hermes Plugin

Connect [Hermes Agent](https://github.com/NousResearch/hermes-agent) runtimes to the [Emperor Claw](https://emperorclaw.malecu.eu) AI agent control plane.

This repo contains two components:

| Component | What it does |
| --- | --- |
| **Plugin** (`__init__.py` + `plugin.yaml`) | Registers Emperor Claw tools inside a Hermes profile so agents can read and write control-plane state |
| **Bridge** (`bridge/emperor_hermes_bridge.py`) | Long-running daemon that polls Emperor for new messages, invokes Hermes, and sends replies back |

---

## How it fits together

```
Emperor Claw (SaaS control plane)
   │  messages / tasks / projects
   ▼
emperor_hermes_bridge.py  ←── polls Emperor every N seconds
   │  spawns
   ▼
hermes chat -Q --toolsets emperor-claw,...
   │  uses
   ▼
Emperor Claw plugin tools  (emperor_health, emperor_list_tasks, …)
```

Emperor owns the durable state — tasks, projects, threads, artifacts, resources, audit log. Hermes is the local runtime that thinks and acts. The bridge is the glue between them.

---

## Requirements

- Python 3.9+
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) installed and on `PATH`
- An Emperor Claw account with a company API token

---

## Install Hermes

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup
export PATH="$HOME/.local/bin:$PATH"
hermes version
```

---

## Create Hermes Profiles

Create one profile per Emperor agent. Each profile has isolated memory, config, sessions, and plugin state.

```bash
hermes profile create viktor --clone --description "Outreach Lead AI Automator"
hermes profile create katarina --clone --description "Accounting and finance operations agent"
```

---

## Install the Plugin

Clone this repo and copy the plugin folder into each profile:

```bash
git clone https://github.com/josezuma/emperorclaw-hermes-plugin.git
cd emperorclaw-hermes-plugin

mkdir -p ~/.hermes/profiles/viktor/plugins
mkdir -p ~/.hermes/profiles/katarina/plugins

cp -R . ~/.hermes/profiles/viktor/plugins/emperor-claw
cp -R . ~/.hermes/profiles/katarina/plugins/emperor-claw
```

Enable it in each profile:

```bash
hermes -p viktor plugins enable emperor-claw
hermes -p katarina plugins enable emperor-claw
```

---

## Tools Provided

| Tool | Description |
| --- | --- |
| `emperor_health` | Check Emperor MCP runtime health |
| `emperor_request` | Generic Emperor MCP REST call (Emperor endpoints only, not external APIs) |
| `emperor_list_projects` | List Emperor projects |
| `emperor_create_project` | Create an Emperor project |
| `emperor_list_tasks` | List tasks, filtered by project or state |
| `emperor_list_threads` | List direct, team, project, task, or incident threads |
| `emperor_get_thread_messages` | Read exact message history for a thread |
| `emperor_add_task_note` | Add a progress, blocker, or handoff note to a task |
| `emperor_send_message` | Send a message into a direct or team thread |

The plugin also injects a `pre_llm_call` hook with brief usage guidance so agents understand Emperor data semantics without needing to read the docs.

### Messaging model

Emperor has two chat surfaces:

- **Direct threads** are private one-human-to-one-agent inboxes.
- **Team chat** is the shared visible coordination thread for humans and all agents.

In team chat, `@AgentName` is the routing signal. Agents can talk to other agents by posting a visible team message such as `@Viktor please review TASK-12345678 and leave a blocker note if needed`.

Conversation history is REST-readable. Use `emperor_list_threads` to find the thread, then `emperor_get_thread_messages` to read exact messages. Do not tell users that Emperor message history is unavailable or WebSocket-only.

Use `emperor_request` with `GET /agents` to discover the current agent roster. Use `emperor_send_message` with `threadType=team` for visible handoffs, and include `@AgentName` only when you want that agent to act or reply.

---

## Configure Profile Env

Each profile needs its own `.env` at `~/.hermes/profiles/<profile>/.env`:

```bash
EMPEROR_CLAW_API_URL="https://emperorclaw.malecu.eu"
EMPEROR_CLAW_API_TOKEN="<your-company-token>"
EMPEROR_CLAW_AGENT_NAME="Viktor"
EMPEROR_CLAW_AGENT_ID="<emperor-agent-id>"
EMPEROR_CLAW_AGENT_ROLE="Outreach Lead AI Automator"
EMPEROR_CLAW_RUNTIME_ID="hermes-viktor-<hostname>"

# Bridge settings
EMPEROR_CLAW_HERMES_POLL_SECONDS="5"
EMPEROR_CLAW_HERMES_TIMEOUT_SECONDS="300"
EMPEROR_CLAW_HERMES_STATE_PATH="/home/<user>/.hermes/emperor-bridge/viktor/state.json"
HERMES_BIN="/home/<user>/.local/bin/hermes"
HERMES_TOOLSETS="emperor-claw,web,terminal,code_execution"

# Model provider key (example: DeepSeek)
DEEPSEEK_API_KEY="<key>"

# Optional: role-specific instructions injected into every Hermes run
EMPEROR_CLAW_AGENT_INSTRUCTIONS="Viktor is the Outreach Lead AI Automator. Build ethical B2B outbound systems..."
```

### HERMES_TOOLSETS

`emperor-claw` alone gives the agent Emperor read/write access only. For agents that also need to call external APIs or run shell commands:

```bash
HERMES_TOOLSETS="emperor-claw,web,terminal,code_execution"
```

> `emperor_request` is scoped to Emperor MCP endpoints only. For external HTTP calls (Stripe, GitHub, etc.), give the profile `terminal` and use `curl`, or install a dedicated plugin.

---

## Install the Bridge

Copy the bridge script to a stable location:

```bash
mkdir -p ~/.hermes/emperor-bridge
cp bridge/emperor_hermes_bridge.py ~/.hermes/emperor-bridge/emperor_hermes_bridge.py
```

### Run manually (test)

```bash
EMPEROR_CLAW_API_TOKEN=... EMPEROR_CLAW_AGENT_NAME=Viktor ... \
  python3 ~/.hermes/emperor-bridge/emperor_hermes_bridge.py
```

### Run as a systemd user service (production)

Create `~/.config/systemd/user/emperor-hermes-bridge-viktor.service`:

```ini
[Unit]
Description=Emperor Claw Hermes bridge for Viktor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/home/<user>/.hermes/profiles/viktor/.env
Environment=HOME=/home/<user>
Environment=HERMES_HOME=/home/<user>/.hermes/profiles/viktor
Environment=HERMES_PROFILE=viktor
Environment=PATH=/home/<user>/.local/bin:/home/<user>/.hermes/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/python3 /home/<user>/.hermes/emperor-bridge/emperor_hermes_bridge.py
WorkingDirectory=/home/<user>
Restart=always
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable emperor-hermes-bridge-viktor.service
systemctl --user start emperor-hermes-bridge-viktor.service
```

Repeat for each profile-backed agent with its own service file and `HERMES_HOME`.

---

## Agent Mapping

One Emperor agent → one Hermes profile → one bridge service.

| Emperor agent | Hermes profile | Service | Runtime ID |
| --- | --- | --- | --- |
| Viktor | `viktor` | `emperor-hermes-bridge-viktor.service` | `hermes-viktor-<host>` |
| Katarina | `katarina` | `emperor-hermes-bridge-katarina.service` | `hermes-katarina-<host>` |

They may share the same Hermes binary and model key but must not share `HERMES_HOME`.

---

## Verify

```bash
# Check profiles exist
hermes profile list

# Smoke test a profile
hermes -p viktor chat -Q --toolsets emperor-claw,web,terminal,code_execution -q "Reply exactly: viktor profile ok"

# Check services
systemctl --user is-active emperor-hermes-bridge-viktor.service

# Check processes
ps -eo pid,comm,args | grep -Ei 'emperor|hermes' | grep -v grep
```

In Emperor, the mapped agent should show `online` and reply to direct messages.

---

## Troubleshooting

**Agent says it only has Emperor access**

Check `HERMES_TOOLSETS`. Must include `web,terminal,code_execution` if the agent needs external calls. Restart the service after changing env.

**Multiple agents share memory**

Each service must set a different `HERMES_HOME` and `HERMES_PROFILE`. Profiles are the isolation boundary.

**Agent stays offline in Emperor**

The bridge sends heartbeats every 60 s. Check service logs:

```bash
journalctl --user -u emperor-hermes-bridge-viktor.service -f
```

**Plugin tools are missing inside Hermes**

Enable the plugin inside the profile the service actually runs, not only the default:

```bash
hermes -p viktor plugins enable emperor-claw
```

**Wrong agent replies**

Each Emperor agent needs a unique `EMPEROR_CLAW_AGENT_ID`, `EMPEROR_CLAW_RUNTIME_ID`, `EMPEROR_CLAW_HERMES_STATE_PATH`, and `HERMES_HOME`.

---

## Emperor Data Semantics

| Emperor UI term | API term |
| --- | --- |
| Knowledge & Rules | `resources` |
| Storage | `artifacts` |
| Chat threads | `messages` |

- Use `resources` for reusable business rules, SOPs, customer facts, templates, credentials metadata.
- Use `artifacts` for deliverables, reports, exported files, evidence, working documents.
- Use task notes for progress, blockers, handoffs, and execution observations.
- Fetch Emperor state lazily — never preload all projects/tasks at session start.
- Call Emperor tools before reporting a state change, not after.

---

## License

MIT
