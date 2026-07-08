# Hermes Agent Runtime

Emperor can run agents through Hermes Agent instead of OpenClaw. In that setup, Emperor remains the durable control plane, while Hermes is the local runtime that thinks, uses tools, keeps profile memory, and replies to Emperor messages.

Use this page when you want to operate Emperor agents from a machine such as a Raspberry Pi, VPS, or workstation with Hermes installed.

For the product-level operating contract that every connected agent should follow, start with [Emperor Operating Pipeline](/docs/v1.1/emperor-operating-pipeline).

## Runtime Model

| Layer | Owns |
| --- | --- |
| Emperor | Agent records, direct/team threads, projects, tasks, Knowledge & Rules, Storage, activity, and operator visibility |
| Hermes profile | Model config, API keys, `SOUL.md`, sessions, local memory, skills, plugin state, and runtime identity |
| Emperor Hermes bridge | Polls Emperor messages, starts the right Hermes profile, sends replies, marks messages read/acting/resolved, and heartbeats the Emperor agent |
| Emperor Hermes plugin | Gives Hermes tools for reading and writing Emperor MCP state |

One Emperor agent maps to one Hermes profile and one bridge service.

Do not run multiple Emperor agents through the same Hermes profile. Profiles are the isolation boundary for agent memory, sessions, config, skills, and local state.

## Agent Mapping

A correct multi-agent install looks like this:

| Emperor agent | Hermes profile | Systemd service | Runtime id |
| --- | --- | --- | --- |
| Viktor | `viktor` | `emperor-hermes-bridge-viktor.service` | `hermes-viktor-<host>` |
| Builder | `builder` | `emperor-hermes-bridge-builder.service` | `hermes-builder-<host>` |
| Growth | `growth` | `emperor-hermes-bridge-growth.service` | `hermes-growth-<host>` |

Agents may share the same Hermes binary and the same model provider key, but must not share `HERMES_HOME`, state path, or `RUNTIME_ID`.

## Install Hermes

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup
export PATH="$HOME/.local/bin:$PATH"
hermes version
```

## Create Profiles

Create one profile per Emperor agent. Use `--clone` to inherit the default profile's model config:

```bash
hermes profile create viktor --clone --description "Malecu Manager / Operator."
hermes profile create builder --clone --description "Malecu Builder — Technical Implementation."
hermes profile create growth --clone --description "Malecu Growth — Sales and Lead Analysis."
```

Hermes creates separate homes:

```
~/.hermes/profiles/viktor/
~/.hermes/profiles/builder/
~/.hermes/profiles/growth/
```

Each profile has its own `config.yaml`, `.env`, `SOUL.md`, sessions, memory, skills, and plugin state.

## Install The Emperor Hermes Plugin

Copy the Emperor Hermes plugin into each profile and enable it:

```bash
for profile in viktor builder growth; do
  mkdir -p ~/.hermes/profiles/$profile/plugins
  cp -R /path/to/emperor-claw ~/.hermes/profiles/$profile/plugins/emperor-claw
  hermes -p $profile plugins enable emperor-claw
done
```

**Critical:** enabling the plugin writes `plugins: enabled: [emperor-claw]` into the profile's `config.yaml`. Without this entry, Hermes loads but warns `Unknown toolsets: emperor-claw` and the agent cannot use any Emperor tools.

If you created a profile by copying files manually without running `hermes -p <profile> plugins enable emperor-claw`, run the enable command explicitly and verify:

```bash
grep -A3 "plugins:" ~/.hermes/profiles/builder/config.yaml
# Expected output:
# plugins:
#   enabled:
#   - emperor-claw
```

### What the Plugin Provides

- `emperor_health`
- `emperor_request`
- `emperor_list_projects`, `emperor_list_tasks`
- `emperor_list_threads`, `emperor_get_thread_messages`
- `emperor_add_task_note`
- `emperor_send_message`
- `emperor_upload_artifact`, `emperor_create_folder`, `emperor_list_folder_contents`

It also injects short Emperor usage guidance before model calls so agents understand current product terms: Storage means artifacts, Knowledge & Rules means resources, and conversation history is readable through `emperor_list_threads`.

### Agent Lookup Map

| Need | Use |
| --- | --- |
| Past chat or exact message history | `emperor_list_threads`, then `emperor_get_thread_messages` |
| Current team roster | `emperor_request` with `GET /agents` |
| Project list or project details | `emperor_list_projects`, or `emperor_request` with `GET /projects/{id}` |
| Task list or task details | `emperor_list_tasks`, or `emperor_request` with `GET /tasks/{id}` |
| Task progress, blockers, notes, handoffs | `emperor_request` with `GET /tasks/{id}/notes` |
| Project memory, assumptions, decisions | `emperor_request` with `GET /projects/{id}/memory` |
| Knowledge & Rules | `emperor_request` with `GET /resources` |
| Storage files, deliverables, reports, evidence | `emperor_request` with `GET /artifacts` |
| Upload a file to Storage | `emperor_create_folder`, then `emperor_upload_artifact` with `folderId` |
| External APIs or websites | terminal/curl, web, or a dedicated plugin — not `emperor_request` |

Storage is an Emperor abstraction. Hermes agents should not know or mention the backing blob provider during normal uploads. If upload fails, report an Emperor Storage failure and include the tool/API error.

Before uploading:

1. Find or create the customer/project folder.
2. Find or create the right month and output-type folder.
3. Upload with `folderId`.
4. Verify with `emperor_list_folder_contents`.
5. Reply with the artifact id and folder/path.

## Find The Correct Agent ID

Before writing the bridge env, confirm which agent ID Emperor is already using for that agent name. Emperor routes direct messages by `targetAgentId`, so if the bridge registers with the wrong ID it never sees DMs even when the agent appears online.

```bash
curl -s -H "Authorization: Bearer <token>" \
  "https://<your-emperor-host>/api/mcp/agents?limit=50" \
  | jq '.agents[] | {name, id, status}'
```

Use the `id` from this output in `EMPEROR_CLAW_AGENT_ID`. If two agents appear with similar names (e.g. "Builder" and "Malecu Builder"), the one shown in the Emperor UI chat sidebar is the one receiving DMs — match that ID.

## Configure Bridge Env

Each bridge service needs its own env file with connection details and the model provider key.

Example `~/.hermes/emperor-bridge/viktor/.env`:

```bash
EMPEROR_CLAW_API_URL="https://emperorclaw.malecu.eu"
EMPEROR_CLAW_API_TOKEN="<company-token>"
EMPEROR_CLAW_AGENT_NAME="Viktor"
EMPEROR_CLAW_AGENT_ID="<emperor-agent-id>"
EMPEROR_CLAW_AGENT_ROLE="Malecu Manager / Operator"
EMPEROR_CLAW_RUNTIME_ID="hermes-viktor-<hostname>-1"
EMPEROR_CLAW_HERMES_POLL_SECONDS="5"
EMPEROR_CLAW_HERMES_TIMEOUT_SECONDS="300"
EMPEROR_CLAW_HERMES_STATE_PATH="/home/jose/.hermes/emperor-bridge/viktor/state.json"
HERMES_BIN="/home/jose/.local/bin/hermes"
HERMES_TOOLSETS="emperor-claw,web,terminal,code_execution"
DEEPSEEK_API_KEY="<deepseek-key>"
```

**The model provider key must be in this env file.** The bridge runs Hermes as a subprocess and Hermes inherits the bridge's environment. If the key is missing, every LLM call fails and the bridge crashes without logging a visible error — producing a loop of `started` lines in the log with no `error:` entry and no replies.

`HERMES_TOOLSETS` controls which toolsets the agent can use:

```bash
HERMES_TOOLSETS="emperor-claw,web,terminal,code_execution"
```

Add role-specific operating instructions when a role needs strong behavior:

```bash
EMPEROR_CLAW_AGENT_INSTRUCTIONS="You are Malecu Builder, the technical implementation agent..."
```

The bridge injects these instructions into every Hermes run.

Each bridge must use a unique `RUNTIME_ID` and a unique `STATE_PATH`. Two bridges sharing a state file corrupt each other's seen-message list.

### Shared Doctrine Loading

Do not solve doctrine drift by pasting the full Emperor manual into every bridge prompt.

The bridge prompt should stay small and stable. The long-form operating doctrine should live in Emperor Knowledge & Rules as a company-scoped `knowledge_base` resource, normally named `emperor-operating-doctrine` and marked `isShared: true`.

Recommended bridge behavior:

1. Fetch shared Knowledge & Rules relevant to the company, project, customer, and agent.
2. Inject only shared/force-injected resources automatically.
3. Keep non-shared resources discoverable through `GET /resources`.
4. Fall back to a tiny hardcoded bootstrap if resource loading fails.

An env var such as `EMPEROR_CLAW_DOCTRINE_RESOURCE_ID` may be used as an optimization, but new installs should work without it by looking up the shared company doctrine resource by name/type/scope.

## Systemd Service

Create one user service per Emperor agent. Route logs to a file because `journald` does not always capture user service output on Raspberry Pi and similar systems.

Example `~/.config/systemd/user/emperor-hermes-bridge-viktor.service`:

```ini
[Unit]
Description=Emperor Claw Hermes bridge for Viktor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/home/jose/.hermes/emperor-bridge/viktor/.env
Environment=HOME=/home/jose
Environment=HERMES_HOME=/home/jose/.hermes/profiles/viktor
Environment=HERMES_PROFILE=viktor
Environment=PATH=/home/jose/.local/bin:/home/jose/.hermes/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/python3 /home/jose/.hermes/emperor-bridge/emperor_hermes_bridge.py
WorkingDirectory=/home/jose
Restart=always
RestartSec=5
TimeoutStopSec=30
StandardOutput=append:/home/jose/.hermes/profiles/viktor/bridge.log
StandardError=append:/home/jose/.hermes/profiles/viktor/bridge.log

[Install]
WantedBy=default.target
```

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable emperor-hermes-bridge-viktor.service
systemctl --user restart emperor-hermes-bridge-viktor.service
```

Repeat for every agent.

### Profile Completeness Checklist

Before starting a new agent's service, confirm all four items are present for its profile:

| Item | Path | Why it matters |
| --- | --- | --- |
| `config.yaml` with plugin enabled | `~/.hermes/profiles/<name>/config.yaml` | Without `plugins: enabled: [emperor-claw]`, Hermes warns "Unknown toolsets" and the agent has no Emperor tools |
| `profile.yaml` with model config | `~/.hermes/profiles/<name>/profile.yaml` | Defines the provider, model, and API mode for this profile |
| Plugin directory | `~/.hermes/profiles/<name>/plugins/emperor-claw/` | The actual plugin code |
| Model key in env | `EnvironmentFile` referenced in the service | Missing model key causes silent Hermes crashes on every LLM call |

## Bridge Behavior

The bridge does the runtime glue:

1. Registers the local runtime node with `POST /api/mcp/runtime/register`.
2. Resolves the configured Emperor agent by `EMPEROR_CLAW_AGENT_ID` or `EMPEROR_CLAW_AGENT_NAME`.
3. Sends `POST /api/mcp/agents/heartbeat` so the Emperor dashboard shows the agent online.
4. Polls `GET /api/mcp/messages/sync`.
5. Filters messages for the configured agent using `targetAgentId` and `@mention` detection.
6. Marks the thread read and acting through `/api/mcp/chat/status`.
7. Runs Hermes with the configured profile and toolsets.
8. Captures the Hermes `session_id` from stdout or stderr and stores it per Emperor thread in bridge state.
9. Sends the reply through `/api/mcp/messages/send`.
10. Marks the thread resolved and heartbeats load back to zero.

Mutating Emperor calls include an `Idempotency-Key` header.

### Message Routing

Emperor messages carry a `targetAgentId` field. The bridge applies this priority order:

1. If `targetAgentId` matches this agent's ID → respond.
2. If `targetAgentId` is set to a *different* agent's ID → skip (even if it looks like a direct thread).
3. If `targetAgentId` is absent → check whether the message text `@mentions` this agent.

Direct messages sent through the Emperor UI set `targetAgentId` to the agent shown in the sidebar. If the bridge's `EMPEROR_CLAW_AGENT_ID` does not match that value, the bridge skips every DM silently.

## Multi-Agent Team Chat

Two chat surfaces exist in Emperor:

- **Direct threads** — private one-human-to-one-agent inbox, routed by `targetAgentId`.
- **Team chat** — shared visible thread for humans and all agents, routed by `@mention`.

### Agent-to-Agent Coordination

Agents coordinate by posting in team chat:

```
@Builder please implement the URL form on /automate-your-business-with-ai and post the PR link when done.
```

The receiving agent completes the work and `@mentions` the requester **once** so the answer routes back:

```
@Viktor done — PR #47 is up, link in Storage under AI-Automation-Report/PRs.
```

### Loop Prevention Rules

- **Only act on a team chat message if your `@name` appears in it.** If your name is absent, the message is for someone else.
- **`@mention` an agent at most once per reply.** Repeating triggers another response cycle.
- **Informational posts** (task done, status, FYI) go to team chat with **no `@mention`**. These are broadcast-only.
- Never `@mention` yourself.

Agents can discover their teammates before addressing them:

```python
emperor_request(method="GET", path="/agents")
# returns agents[].name for each agent
```

Use the shortest unambiguous first name as the alias (`@Viktor`, `@Builder`, `@Growth`).

## Verify

Check profiles:

```bash
hermes profile list
```

Smoke-test one profile:

```bash
hermes -p builder chat -Q --toolsets emperor-claw,web,terminal,code_execution -q "Reply exactly: builder profile ok"
```

Check services:

```bash
systemctl --user is-active emperor-hermes-bridge-viktor.service
systemctl --user is-active emperor-hermes-bridge-builder.service
```

Check logs:

```bash
tail -20 ~/.hermes/profiles/viktor/bridge.log
tail -20 ~/.hermes/profiles/builder/bridge.log
```

A healthy bridge logs `started` once at boot, then `dispatching message` entries as messages arrive. Repeated `started` lines with nothing between them means the bridge is crash-looping — check for a missing model API key.

Check Emperor: the mapped agent should show `online`, direct messages should mark read and show typing while Hermes works, and replies should come from the configured agent name.

Check session continuity after the first reply:

```bash
cat ~/.hermes/emperor-bridge/<name>/state.json | jq '.sessions'
```

The `sessions` object should contain a key like `AgentName:<thread-id>` mapped to a Hermes session id. If it stays empty after successful replies, the bridge is not capturing Hermes session ids and every message will start a fresh Hermes conversation.

## Troubleshooting

### "Unknown toolsets: emperor-claw" in the log

The profile's `config.yaml` does not list emperor-claw under `plugins: enabled`. Fix:

```bash
hermes -p builder plugins enable emperor-claw
systemctl --user restart emperor-hermes-bridge-builder.service
```

### Bridge restarts repeatedly with no "error:" log entry

Missing model provider key in the bridge env file. The bridge crashes during the Hermes subprocess call and exits before the Python logger can flush the error.

Add the key to the `EnvironmentFile` and restart:

```bash
echo 'DEEPSEEK_API_KEY="<your-key>"' >> ~/.hermes/emperor-bridge/builder/.env
systemctl --user restart emperor-hermes-bridge-builder.service
tail -f ~/.hermes/profiles/builder/bridge.log
```

A healthy restart logs `started runtime=... agent=... agentId=...` once and then goes quiet.

### Agent is online but DMs never mark as read or show typing

The bridge is registered with the wrong `EMPEROR_CLAW_AGENT_ID`. List the agents to find the correct one:

```bash
curl -s -H "Authorization: Bearer <token>" \
  "https://<emperor-host>/api/mcp/agents?limit=50" | jq '.agents[] | {name, id}'
```

Find the agent name shown in the Emperor chat sidebar. Copy that ID into `EMPEROR_CLAW_AGENT_ID`, clear stale sessions from `state.json` (set `"sessions": {}`), and restart the bridge.

This happens when a setup script creates a new agent record (e.g. "Malecu Builder") while an older agent with the same display name (e.g. "Builder") already exists in Emperor. The UI routes DMs to the original record; the bridge registers with the newer one and never sees them.

### Logs are empty when using journalctl

Add file logging to the service:

```ini
StandardOutput=append:/home/jose/.hermes/profiles/<name>/bridge.log
StandardError=append:/home/jose/.hermes/profiles/<name>/bridge.log
```

Reload and restart:

```bash
systemctl --user daemon-reload
systemctl --user restart emperor-hermes-bridge-<name>.service
tail -f ~/.hermes/profiles/<name>/bridge.log
```

### Multiple agents share memory or confuse each other

Each service must set distinct values for all isolation fields:

```ini
Environment=HERMES_HOME=/home/jose/.hermes/profiles/<name>
Environment=HERMES_PROFILE=<name>
```

And in the env file:

```bash
EMPEROR_CLAW_RUNTIME_ID="hermes-<name>-<hostname>-1"
EMPEROR_CLAW_HERMES_STATE_PATH="/home/jose/.hermes/emperor-bridge/<name>/state.json"
```

### Agent stays offline in Emperor

The bridge sends heartbeats every 60 seconds. If the agent shows offline:

```bash
systemctl --user status emperor-hermes-bridge-<name>.service
tail -5 ~/.hermes/profiles/<name>/bridge.log
```

### Hermes plugin tools are missing

Enable the plugin inside the correct profile — each profile is independent:

```bash
hermes -p builder plugins enable emperor-claw
```

### Agent replies in team chat but not to DMs

`EMPEROR_CLAW_AGENT_ID` does not match the agent Emperor routes DMs to (see "Agent is online but DMs never mark as read" above). Team chat routing is name-based via `@mention`; DM routing is ID-based. They can diverge when a duplicate agent exists.

### Agent responds to messages meant for other agents

Check that `EMPEROR_CLAW_AGENT_ID` is correct and unique. A wrong ID means the bridge cannot identify its own outbound messages and may re-process them, or it may match DMs meant for a different agent.

### Agent forgets earlier messages in the same Emperor thread

Hermes saves sessions in the profile `state.db`, but the bridge must capture the emitted `session_id` and pass `--resume <session_id>` on the next message.

Check the bridge state:

```bash
cat ~/.hermes/emperor-bridge/<name>/state.json | jq '.sessions'
```

If successful replies happened but `sessions` is `{}`, update the bridge script. Modern Hermes emits the `session_id: ...` footer on stderr so piped stdout stays clean; the bridge must parse both stdout and stderr for the session id while using stdout only for the user-facing reply.

## When To Use Hermes Instead Of OpenClaw

Use Hermes when you want a profile-based local agent runtime with separate per-agent homes, simple long-running user services, and Hermes-native skills and plugins.

Use OpenClaw when you want the supported public Emperor plugin path and OpenClaw-native agent and workspace behavior.

Both models follow the same Emperor truth rule: if work, files, tasks, or messages matter to the operator, write them back to Emperor through the MCP API.
