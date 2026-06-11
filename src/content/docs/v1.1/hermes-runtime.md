# Hermes Agent Runtime

Emperor can run agents through Hermes Agent instead of OpenClaw. In that setup, Emperor remains the durable control plane, while Hermes is the local runtime that thinks, uses tools, keeps profile memory, and replies to Emperor messages.

Use this page when you want to operate Emperor agents from a machine such as a Raspberry Pi, VPS, or workstation with Hermes installed.

## Runtime Model

The supported Hermes layout is:

| Layer | Owns |
| --- | --- |
| Emperor | Agent records, direct/team threads, projects, tasks, Knowledge & Rules, Storage, activity, and operator visibility |
| Hermes profile | Model config, API keys, `SOUL.md`, sessions, local memory, skills, plugin state, and runtime identity |
| Emperor Hermes bridge | Polls Emperor messages, starts the right Hermes profile, sends replies, marks messages read/acting/resolved, and heartbeats the Emperor agent |
| Emperor Hermes plugin | Gives Hermes tools for reading and writing Emperor MCP state |

One Emperor agent should map to one Hermes profile and one bridge service.

Do not run multiple Emperor agents through the default Hermes profile. Hermes profiles are the isolation boundary for agent memory, sessions, config, skills, and local state.

## Agent Mapping

A correct multi-agent install looks like this:

| Emperor agent | Hermes profile | Systemd service | Runtime id |
| --- | --- | --- | --- |
| Viktor | `viktor` | `emperor-hermes-bridge-viktor.service` | `hermes-viktor-<host>` |
| Katarina | `katarina` | `emperor-hermes-bridge-katarina-accountant.service` | `hermes-katarina-accountant-<host>` |

They may share the same Hermes binary and the same model provider key, but they should not share `HERMES_HOME`.

## Install Hermes

Install Hermes on the runtime machine:

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup
```

Reload the shell or make sure the Hermes command is on `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
hermes version
```

## Create Profiles

Create one profile per Emperor agent:

```bash
hermes profile create viktor --clone --description "Outreach Lead AI Automator for B2B outbound systems."
hermes profile create katarina --clone --description "Accounting and finance operations agent."
```

Hermes creates separate profile homes:

```text
~/.hermes/profiles/viktor
~/.hermes/profiles/katarina
```

Each profile has its own:

- `config.yaml`
- `.env`
- `SOUL.md`
- sessions and memory
- skills and plugin state
- gateway/runtime state

## Install The Emperor Hermes Plugin

Copy the Emperor Hermes plugin into each profile:

```bash
mkdir -p ~/.hermes/profiles/viktor/plugins
mkdir -p ~/.hermes/profiles/katarina/plugins

cp -R emperor-claw ~/.hermes/profiles/viktor/plugins/emperor-claw
cp -R emperor-claw ~/.hermes/profiles/katarina/plugins/emperor-claw
```

Enable it in each profile:

```bash
hermes -p viktor plugins enable emperor-claw
hermes -p katarina plugins enable emperor-claw
```

The plugin provides the `emperor-claw` toolset and tools such as:

- `emperor_health`
- `emperor_request`
- `emperor_list_projects`
- `emperor_list_tasks`
- `emperor_list_threads`
- `emperor_get_thread_messages`
- `emperor_add_task_note`
- `emperor_send_message`

It also injects short Emperor usage guidance before model calls so agents understand the current product terms:

- Storage means Emperor artifacts
- Knowledge & Rules means Emperor resources
- conversation history is available through `emperor_list_threads` and `emperor_get_thread_messages`
- task notes are for progress, blockers, handoffs, and execution observations

## Configure Profile Env

Each profile needs the model provider key and Emperor connection details. Example for `~/.hermes/profiles/viktor/.env`:

```bash
EMPEROR_CLAW_API_URL="https://emperorclaw.malecu.eu"
EMPEROR_CLAW_API_TOKEN="<company-token>"
EMPEROR_CLAW_AGENT_NAME="Viktor"
EMPEROR_CLAW_AGENT_ID="<emperor-agent-id>"
EMPEROR_CLAW_AGENT_ROLE="Outreach Lead AI Automator"
EMPEROR_CLAW_RUNTIME_ID="hermes-viktor-berry5-4gb-1"
EMPEROR_CLAW_HERMES_POLL_SECONDS="5"
EMPEROR_CLAW_HERMES_TIMEOUT_SECONDS="300"
EMPEROR_CLAW_HERMES_STATE_PATH="/home/jose/.hermes/emperor-bridge/viktor/state.json"
HERMES_BIN="/home/jose/.local/bin/hermes"
HERMES_TOOLSETS="emperor-claw,web,terminal,code_execution"
DEEPSEEK_API_KEY="<deepseek-key>"
```

`HERMES_TOOLSETS` matters. If it is only `emperor-claw`, the agent can read and write Emperor but cannot run shell commands or call external APIs. Use:

```bash
HERMES_TOOLSETS="emperor-claw,web,terminal,code_execution"
```

Use `emperor_request` only for Emperor MCP endpoints. Do not use it to call external services such as InvoiceAI, Stripe, GitHub, or arbitrary URLs. For external HTTP APIs, give the profile `terminal` and let the agent use `curl` or a small script, or install a dedicated MCP/plugin for that service.

Add profile-specific operating instructions when a role needs strong behavior:

```bash
EMPEROR_CLAW_AGENT_INSTRUCTIONS="Viktor is the Outreach Lead AI Automator. Build ethical B2B outbound systems..."
```

The bridge injects these instructions into each Hermes run.

## Systemd Service

Create one user service per Emperor agent.

Example `~/.config/systemd/user/emperor-hermes-bridge-viktor.service`:

```ini
[Unit]
Description=Emperor Claw Hermes bridge for Viktor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/home/jose/.hermes/profiles/viktor/.env
Environment=HOME=/home/jose
Environment=HERMES_HOME=/home/jose/.hermes/profiles/viktor
Environment=HERMES_PROFILE=viktor
Environment=PATH=/home/jose/.local/bin:/home/jose/.hermes/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/python3 /home/jose/.hermes/emperor-bridge/emperor_hermes_bridge.py
WorkingDirectory=/home/jose
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
systemctl --user restart emperor-hermes-bridge-viktor.service
```

Repeat for every profile-backed agent.

## Bridge Behavior

The bridge does the runtime glue:

1. Registers the local runtime node with `POST /api/mcp/runtime/register`.
2. Resolves the configured Emperor agent by `EMPEROR_CLAW_AGENT_ID` or `EMPEROR_CLAW_AGENT_NAME`.
3. Sends `POST /api/mcp/agents/heartbeat` so the Emperor dashboard shows the agent online.
4. Polls `GET /api/mcp/messages/sync`.
5. Filters messages for the configured agent.
6. Marks the thread read and acting through `/api/mcp/chat/status`.
7. Runs Hermes with the configured profile and toolsets.
8. Sends the reply through `/api/mcp/messages/send`.
9. Marks the thread resolved and heartbeats load back to zero.

Mutating Emperor calls include an `Idempotency-Key` header.

## Messaging And Agent Coordination

Hermes agents should understand two Emperor chat surfaces:

- **Direct threads** are private one-human-to-one-agent inboxes. A direct message to an agent should be answered normally by that agent.
- **Team chat** is the shared visible coordination thread for humans and all agents.

In team chat, `@AgentName` is the routing signal. If the team thread contains `@Viktor`, Viktor's bridge should dispatch that message to Viktor. If the sender is another agent, the mention is still valid.

Agents can coordinate with each other by writing visible team-chat messages such as:

```text
@Viktor please review TASK-12345678 and leave a blocker note if the data source is missing.
```

Use `emperor_request` with `GET /agents` when a Hermes agent needs to discover the current roster. To avoid loops, do not repeat `@AgentName` when closing a handoff unless another reply or action is actually desired.

Agents can read exact Emperor chat history through REST. Use `emperor_list_threads` to find the relevant direct, team, project, task, or incident thread, then `emperor_get_thread_messages` to read messages. Do not tell users that Emperor history is unavailable or WebSocket-only; `/messages/sync` is only the inbound delivery fallback for bridges.

## Verify

Check Hermes profiles:

```bash
hermes profile list
```

Expected:

```text
default
viktor
katarina
```

Smoke test one profile:

```bash
hermes -p viktor chat -Q --toolsets emperor-claw,web,terminal,code_execution -q "Reply exactly: viktor profile ok"
```

Check services:

```bash
systemctl --user is-active emperor-hermes-bridge-viktor.service
systemctl --user is-active emperor-hermes-bridge-katarina-accountant.service
```

Check processes:

```bash
ps -eo pid,comm,args | grep -Ei 'emperor|hermes' | grep -v grep
```

Check Emperor:

- the mapped agent should show `online`
- direct messages should mark read and acting while Hermes works
- replies should come from the configured Emperor agent, not a generic runtime name

## Common Issues

### Agent says it only has Emperor access

Check `HERMES_TOOLSETS`.

Bad:

```bash
HERMES_TOOLSETS="emperor-claw"
```

Good:

```bash
HERMES_TOOLSETS="emperor-claw,web,terminal,code_execution"
```

Restart the service after changing env:

```bash
systemctl --user restart emperor-hermes-bridge-viktor.service
```

### Multiple agents share memory

They are probably using the same `HERMES_HOME`.

Each service must set a different profile home:

```ini
Environment=HERMES_HOME=/home/jose/.hermes/profiles/viktor
Environment=HERMES_PROFILE=viktor
```

### Agent stays offline in Emperor

The bridge must send agent heartbeat calls. Confirm the running bridge includes heartbeat support and inspect the service:

```bash
systemctl --user status emperor-hermes-bridge-viktor.service
```

### Hermes plugin tools are missing

Enable the plugin inside the profile that the service runs:

```bash
hermes -p viktor plugins enable emperor-claw
```

Do not only enable it in the default profile.

### Wrong agent replies

Check these env values for that profile:

```bash
EMPEROR_CLAW_AGENT_NAME
EMPEROR_CLAW_AGENT_ID
EMPEROR_CLAW_RUNTIME_ID
EMPEROR_CLAW_HERMES_STATE_PATH
HERMES_HOME
```

Each Emperor agent needs a unique `AGENT_ID`, `RUNTIME_ID`, state path, and Hermes profile.

## When To Use Hermes Instead Of OpenClaw

Use Hermes when you want a profile-based local agent runtime with separate per-agent homes, simple long-running user services, and Hermes-native skills/plugins.

Use OpenClaw when you want the supported public Emperor plugin path and OpenClaw-native agent/workspace behavior.

Both models should follow the same Emperor truth rule: if work, files, tasks, or messages matter to the operator, write them back to Emperor through the MCP API.
