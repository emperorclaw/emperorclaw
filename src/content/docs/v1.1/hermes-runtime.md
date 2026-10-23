# Hermes Agent Runtime

Emperor can run agents through Hermes Agent instead of OpenClaw. Emperor remains the durable control plane. Hermes is the local runtime that thinks, uses tools, keeps profile memory, and replies to Emperor messages.

Use this page to run Emperor agents on your own machine (a workstation, VPS, or Raspberry Pi) with Hermes. Upgrading from bridge 0.3? Read [Migrating Hermes agents to 0.9](/docs/v1.1/hermes-migration-0-9) first.

For the operating contract every connected agent follows, start with [Emperor Operating Pipeline](/docs/v1.1/emperor-operating-pipeline).

## Runtime Model

Since Emperor Claw 0.9, every Hermes agent stays warm. A message travels from Emperor to a running Hermes gateway over a local WebSocket, and live steps (tool calls, reasoning, usage) stream back to Emperor while the agent works.

| Layer | Owns |
| --- | --- |
| Emperor | Agent records, direct/team threads, projects, tasks, Knowledge & Rules, Storage, activity, and operator visibility |
| Hermes profile | Model config, API keys, `SOUL.md`, sessions (`state.db`), local memory, skills, plugin state, and runtime identity |
| Hermes gateway (v0.22.4) | A long-running Hermes process that keeps the profile's sessions warm |
| Emperor bridge 0.9 | Picks up Emperor messages, submits them to the gateway, streams live steps, sends replies, and heartbeats the agent |
| Emperor plugin | Gives Hermes tools for reading and writing Emperor state |

One Emperor agent maps to one Hermes profile. Do not run several Emperor agents through the same profile: profiles are the isolation boundary for memory, sessions, config, skills, and local state.

## Agent Mapping

| Emperor agent | Hermes profile | Gateway unit | Bridge unit |
| --- | --- | --- | --- |
| Viktor | `viktor` | `emperor-hermes-gateway@viktor` | `emperor-hermes-bridge@viktor` |
| Builder | `builder` | `emperor-hermes-gateway@builder` | `emperor-hermes-bridge@builder` |
| Growth | `growth` | `emperor-hermes-gateway@growth` | `emperor-hermes-bridge@growth` |

This is the **standalone** layout (the default): each agent has its own gateway process. Small machines can opt into one **shared** gateway for all agents on the host (`emperor-hermes-gateway-shared` + `emperor-hermes-bridge-shared`). See [Small machines](/docs/v1.1/hermes-migration-0-9) in the migration guide before choosing it.

## Install

Requirements: Linux with systemd, `curl`, `git`, `tar`, `python3`, and a user account with lingering enabled (`loginctl enable-linger $USER`). No sudo is needed.

1. Download the installer:

   ```bash
   mkdir -p ~/.local/bin
   curl -fsSL https://github.com/emperorclaw/emperorclaw/releases/download/v0.9.2/emperor-hermes.sh -o ~/.local/bin/emperor-hermes
   chmod +x ~/.local/bin/emperor-hermes
   ```

2. Create one Hermes profile per agent and put its Emperor credentials in the profile's `.env` (example below). If Hermes is not installed yet, `emperor-hermes install` creates a missing profile for you; fill in its `.env` and run the command again.

3. Check that the host has room for the agents:

   ```bash
   emperor-hermes doctor --plan --profiles viktor,builder,growth
   ```

   A gateway uses about 300 MiB once warm. The plan says `standalone`, `shared` (needs `--gateway shared`), or which agents to move to another host.

4. Install:

   ```bash
   emperor-hermes install --profile viktor,builder,growth
   ```

   The installer installs Hermes v0.22.4 (pinned to an exact commit) next to any existing Hermes, resolves Hermes' own Python for the bridge, installs the bridge, plugin and systemd user units, applies Emperor's profile defaults, then starts each gateway and its bridge. It is safe to run again.

5. Check: `emperor-hermes status`. Each agent should show a `ready 0.22.4` gateway and an active bridge, and appear online in Emperor.

### Profile `.env`

The bridge and the plugin read each agent's settings from its profile, `~/.hermes/profiles/<profile>/.env`:

```bash
EMPEROR_CLAW_API_URL="https://emperorclaw.example.com"
EMPEROR_CLAW_API_TOKEN="<agent token>"
EMPEROR_CLAW_AGENT_ID="<emperor-agent-id>"
EMPEROR_CLAW_AGENT_NAME="Viktor"
EMPEROR_CLAW_HERMES_TOOLSETS="emperor-claw,web,terminal,code_execution"
DEEPSEEK_API_KEY="<model provider key>"
```

Optional per-agent settings:

| Variable | Default | Use |
| --- | --- | --- |
| `EMPEROR_CLAW_HERMES_MAX_PARALLEL_TURNS` | `3` | Threads handled at the same time. Use `1` on small hosts and for agents sharing a working directory |
| `EMPEROR_CLAW_HERMES_COMPACT_AFTER_TOKENS` | `60000` | Context size that triggers compaction after a reply. `0` turns it off |
| `EMPEROR_CLAW_HERMES_TURN_IDLE_TIMEOUT_SECONDS` | `900` | Interrupt a turn after this long with no activity |
| `EMPEROR_CLAW_HERMES_CWD` | `$HOME` | Working directory for new sessions |

A token rotation takes effect on the agent's next tool call. A model key rotation needs a gateway restart: `emperor-hermes restart-gateway --profile <p> --when-idle`.

### What gets installed

| Path | Purpose |
| --- | --- |
| `~/.local/bin/emperor-hermes` | The installer |
| `~/.hermes/hermes-agent-v0.22.4/` | Pinned Hermes checkout. `~/.local/bin/hermes` is only repointed by `emperor-hermes finalize` |
| `~/.local/share/emperor-hermes/python` | Small wrapper that runs Hermes' own Python. The bridge runs on it |
| `~/.hermes/emperor-bridge/releases/<version>/`, `current` | Bridge bundles |
| `~/.config/emperor-hermes/host.env` | Install paths for the units. Rewritten by `emperor-hermes update` |
| `~/.config/systemd/user/emperor-hermes-*.service` | Unit templates and a daily log rotation timer |
| `~/.hermes/profiles/<p>/plugins/emperor-claw/` | The plugin, per profile |
| `~/.hermes/profiles/<p>/emperor/` | Bridge state and the turn files the plugin reads |
| `~/.hermes/backups/emperor-hermes/` | Backups taken before the first 0.9 start (`state.db`, config, `.env`, plugin) |

## Operate

| Task | Command |
| --- | --- |
| Health of every agent | `emperor-hermes status` |
| Bridge log | `tail -f ~/.hermes/profiles/<p>/bridge.log` (shared: `~/.hermes/emperor-bridge/shared.log`) |
| Gateway log | `journalctl --user -u emperor-hermes-gateway@<p>` |
| Update the bridge | `emperor-hermes update` |
| Restart a gateway safely | `emperor-hermes restart-gateway --profile <p> --when-idle` |
| Memory in use | `emperor-hermes doctor --measure` |
| Go back to the previous bridge bundle | `emperor-hermes rollback --bridge-only` |
| Go back to bridge 0.3 | `emperor-hermes rollback --profile <p>` |

Stopping a turn from Emperor interrupts it in about a second. If the network drops mid-turn, the turn keeps running and its reply and live steps are delivered when the connection returns.

## The Emperor Hermes Plugin

The installer copies the plugin into each profile and enables it. The agent gets tools such as:

- `emperor_health`, `emperor_request`
- `emperor_list_projects`, `emperor_list_tasks`, `emperor_add_task_note`
- `emperor_list_threads`, `emperor_get_thread_messages`, `emperor_send_message`
- `emperor_list_groups`, `emperor_create_group`, `emperor_add_group_members`, `emperor_remove_group_member`
- `emperor_upload_artifact`, `emperor_create_folder`, `emperor_list_folder_contents`

The Emperor operating guide is part of each agent's session instructions, and the plugin ships it as a skill. Storage means artifacts, Knowledge & Rules means resources, and conversation history is readable through `emperor_list_threads`.

### Agent Lookup Map

| Need | Use |
| --- | --- |
| Past chat or exact message history | `emperor_list_threads`, then `emperor_get_thread_messages` |
| Open tasks right now | `emperor_list_tasks` |
| Current team roster | `emperor_request` with `GET /agents` |
| Project list or project details | `emperor_list_projects`, or `emperor_request` with `GET /projects/{id}` |
| Task progress, blockers, notes, handoffs | `emperor_request` with `GET /tasks/{id}/notes` |
| Project memory, assumptions, decisions | `emperor_request` with `GET /projects/{id}/memory` |
| Knowledge & Rules | `emperor_request` with `GET /resources` |
| Storage files, deliverables, reports, evidence | `emperor_request` with `GET /artifacts` |
| Upload a file to Storage | `emperor_create_folder`, then `emperor_upload_artifact` with `folderId` |
| External APIs or websites | terminal/curl, web, or a dedicated plugin, not `emperor_request` |

Storage is an Emperor abstraction. Agents should not mention the backing blob provider. If an upload fails, report an Emperor Storage failure with the tool or API error.

Before uploading:

1. Find or create the customer/project folder.
2. Find or create the right month and output-type folder.
3. Upload with `folderId`.
4. Verify with `emperor_list_folder_contents`.
5. Reply with the artifact id and folder/path.

## Find The Correct Agent ID

Emperor routes direct messages by `targetAgentId`. If the bridge uses the wrong agent id it never sees DMs, even though the agent appears online.

```bash
curl -s -H "Authorization: Bearer <token>" \
  "https://<your-emperor-host>/api/mcp/agents?limit=50" \
  | jq '.agents[] | {name, id, status}'
```

Put the `id` in `EMPEROR_CLAW_AGENT_ID`. If two agents have similar names (for example "Builder" and "Malecu Builder"), use the one shown in the Emperor chat sidebar.

### Shared Doctrine Loading

Do not paste the full Emperor manual into agent instructions. Keep the long-form doctrine in Emperor Knowledge & Rules as a company-scoped `knowledge_base` resource, normally named `emperor-operating-doctrine` and marked `isShared: true`. The bridge places shared and force-injected resources in the session instructions, keeps the rest discoverable through `GET /resources`, and falls back to a short built-in guide if loading fails.

## Bridge Behavior

1. Registers the runtime with `POST /api/mcp/runtime/register` and reports its bridge version, Hermes version and topology.
2. Heartbeats the agent so Emperor shows it online.
3. Picks up messages with `GET /api/mcp/messages/sync` and follows Emperor's routing verdict.
4. Keeps one Hermes session per Emperor thread. Stable context (identity, instructions, operating guide, thread details) lives in the session instructions. Each turn adds only a short note about the sender and any changed tasks.
5. Submits the message to the gateway and streams live steps to Emperor (`POST /api/mcp/agents/runs/{id}/events`).
6. Sends the reply through `/api/mcp/messages/send` and records the run with token usage, model, and duration.
7. Compacts long sessions after the reply is delivered, never before the next message.

Mutating Emperor calls include an `Idempotency-Key` header, so a retried turn never posts a reply twice.

### Message Routing

Emperor decides who answers: each synced message carries `addressedToYou` and a `routeReason` for this agent (see [Messaging](/docs/v1.1/messaging)), and the bridge follows that verdict, including Emperor's agent-to-agent loop guard.

Direct messages sent through the Emperor UI set `targetAgentId` to the agent shown in the sidebar. If `EMPEROR_CLAW_AGENT_ID` does not match that value, the agent never answers DMs.

### Instructions and memory

Each agent has two things in **Agents → (agent)** that shape every turn:

- **Instructions**: its role files (AGENTS.md, SOUL.md, IDENTITY.md, and any you add). The bridge reads them from Emperor, so edits apply on the agent's next message.
- **Memory**: short notes about how to work here: a person's preference, a correction, a lesson. The agent saves them with the `emperor_remember` tool, and you can add or delete them in the **Memory** tab (**Teach … something**). The newest memories (about 3,000 characters) are included.

Both come from `GET /api/mcp/agents/{id}/memory`, which returns `instructions` and the memory `entries`. Agents write with `POST` to the same path (`kind`: preference, lesson, fact, or context). Company facts belong in Knowledge & Rules, and task progress in task notes.

## Multi-Agent Team Chat

Three chat surfaces exist in Emperor:

- **Direct threads**: private one-human-to-one-agent inbox, routed by `targetAgentId`.
- **Team chat**: shared visible thread for humans and all agents, routed by `@mention`.
- **Group chats**: members-only team channels, routed by `@mention` (plus a human's `@all`). Only member agents receive them. Agents manage groups with `emperor_list_groups`, `emperor_create_group`, `emperor_add_group_members`, and `emperor_remove_group_member`. See [Messaging](/docs/v1.1/messaging).

### Agent-to-Agent Coordination

Agents coordinate by posting in team chat:

```
@Builder please implement the URL form on /automate-your-business-with-ai and post the PR link when done.
```

The receiving agent completes the work and `@mentions` the requester **once** so the answer routes back:

```
@Viktor done. PR #47 is up, link in Storage under AI-Automation-Report/PRs.
```

### Loop Prevention Rules

- **Only act on a team chat message if your `@name` appears in it.**
- **`@mention` an agent at most once per reply.** Repeating triggers another response cycle.
- **Informational posts** (task done, status, FYI) go to team chat with **no `@mention`**.
- Never `@mention` yourself, and never post `@all`: it is for humans to address a whole group.

Agents discover teammates with `emperor_request(method="GET", path="/agents")` and use the shortest unambiguous first name (`@Viktor`, `@Builder`, `@Growth`).

## Verify

1. `emperor-hermes status` ends with `STATUS: ok`.
2. In Emperor, send the agent "Reply with exactly: OK". A live status line appears within about a second, and the reply follows.
3. Ask for something that needs a tool. The chat shows each tool step with its duration.
4. Stop a long turn from Emperor. It ends as cancelled within a few seconds.
5. The agent's **Runs** tab shows queue time, first-token time, tokens, model, and exit reason.

## Troubleshooting

### `status` shows the gateway `down`

```bash
journalctl --user -u emperor-hermes-gateway@<p> -n 50
```

Common causes: a missing model key in the profile `.env`, or a broken profile `config.yaml`. Fix it, then `systemctl --user restart emperor-hermes-gateway@<p>`.

### The agent is online but never answers DMs

`EMPEROR_CLAW_AGENT_ID` in the profile `.env` does not match the agent Emperor routes DMs to. See [Find The Correct Agent ID](#find-the-correct-agent-id), then `systemctl --user restart emperor-hermes-bridge@<p>`.

### The agent appears twice, or Emperor reports a duplicate runtime

Only one runtime per agent may run. `emperor-hermes status` prints `DUPLICATE` if a 0.3 bridge unit or a stray 0.3 bridge process still serves the profile. Stop it: `systemctl --user disable --now emperor-hermes-bridge-<p>`.

If a timer, service or cron job you (or an agent) wrote keeps re-enabling the 0.3 bridge, the installer detects it and refuses to migrate until you remove it or pass `--disable-watchdogs`; a full `rollback --all` restores it.

### Shared mode: the bridge refuses to dispatch

Emperor reported `sharedHostOk: false`: the agents on this host belong to different companies. Shared mode needs one company, one operator and one OS user. Switch each agent to standalone (`emperor-hermes install --profile <p> --gateway standalone`) or move it to another host.

### "Unknown toolsets: emperor-claw"

The plugin is not enabled in that profile. Run `emperor-hermes install --profile <p>` again, which re-copies and enables it.

### The bridge restarts in a loop

Check `~/.hermes/profiles/<p>/bridge.log`. `emperor-hermes status` also prints what the bridge reports in its health file. Missing `EMPEROR_CLAW_API_URL` or `EMPEROR_CLAW_API_TOKEN` in the profile `.env` is the usual cause.

## Accessing A Locally-Provisioned Hermes Container

Hiring an agent with the "Local: this machine" option provisions its Hermes runtime as a sibling Docker container on the Emperor host. No SSH or manual profile setup is needed. Containers are named:

```
emperor-hermes-<safeName>-<agentId8>
```

`<safeName>` is the agent name lowercased with non-alphanumeric characters replaced by `-`, and `<agentId8>` is the first 8 characters of the agent's Emperor id. The agent's detail panel shows the container name with a copy button.

```bash
docker ps --filter name=emperor-hermes-        # list
docker exec -it <container-name-or-id> sh      # shell
docker logs -f <container-name-or-id>          # live logs
```

Use **Recreate Runtime** in the agent detail panel to stop, remove, and re-provision the container. It is the same primitive used for image updates and key rotation.

## When To Use Hermes Instead Of OpenClaw

Use Hermes when you want a profile-based local agent runtime with separate per-agent homes, long-running user services, and Hermes-native skills and plugins.

Use OpenClaw when you want the public Emperor plugin path and OpenClaw-native agent and workspace behavior.

Both follow the same Emperor truth rule: if work, files, tasks, or messages matter to the operator, write them back to Emperor through the MCP API.

## Quick Setup via LLM

You can let your own LLM walk you through the setup. Paste this prompt into Claude, ChatGPT, Codex, Gemini, or another capable LLM:

```text
I need to connect a Hermes agent to Emperor Claw, an open-source AI workforce control plane.

Repository & docs: https://github.com/emperorclaw/emperorclaw
Hermes runtime docs: docs/v1.1/hermes-runtime.md in that repository
Installer: https://github.com/emperorclaw/emperorclaw/releases/download/v0.9.2/emperor-hermes.sh

My agent role is: [DESCRIBE YOUR AGENT'S ROLE HERE, e.g. "SEO Specialist"]

Please read the documentation and guide me through:
1. Creating the Hermes profile and its .env for this role: [SAME ROLE]
2. Running emperor-hermes doctor --plan and emperor-hermes install
3. Configuring the agent's SOUL, toolsets, and operating doctrine
4. Verifying it with emperor-hermes status and a test message from Emperor

Walk me through step by step. Ask me for any information you need along the way.
```

## Create additional local workers

Hermes is the only supported local runtime. In **Agents → Hire an Agent → Local**, select a role and name. If an existing Hermes worker has a stored LLM API key, choose its configuration and click **Create Hermes agent**. The new worker reuses that provider, model, and encrypted key, inherits its access scope, and gets a separate container, persistent volume, and agent-bound token. For the first worker, supply a provider and API key.

Hermes workers can hire other Hermes workers with the `emperor_create_agent` tool, passing `name`, `role`, and optionally `doctrineJson` (a mapping of doctrine filenames to text). The server uses the authenticated worker's configuration. No API key needs to appear in prompts or tool results. Check the returned `success` and `agentId`; failed provisioning leaves an offline profile that can be retried through local setup. Container startup is reported separately from online status, which is confirmed by runtime heartbeats.

MCP clients can call `create_agent` with `deploymentMode: "local"`. Company tokens also supply `sourceAgentId`; agent-bound tokens use their own agent as the source. REST clients use the same fields with `POST /api/mcp/agents`. Local hiring requires the Docker installation with its socket mounted. Remote integrations remain available.

## Persistent objectives

Open an agent on the dashboard and expand **Objective**, or use `/goal <objective>` in its direct chat. State the result and optionally add a `verify:` line with the completion criterion. Choose a limit of 5, 10 or 20 turns. Hermes checks progress after each turn and continues in the same session until complete, paused, blocked, waiting or out of turns.

Use **Pause**, **Resume** and **Clear objective**, or `/goal pause`, `/goal resume`, `/goal clear` and `/goal status`. Resume is an explicit request for a fresh turn budget. **Stop & clear queue** and replacing work also pause automatic continuation. Existing agent and company budgets still apply. Goals are per agent; starting one does not create a company mission or start other agents.

This requires a Hermes runtime with native `GoalManager` support. Other runtimes keep their normal messages and do not advertise objectives. Advanced `/goal draft`, gates and manual wait commands are not exposed through this web integration.

The installer sets `HERMES_PYTHON` and `HERMES_CHECKOUT` for the bridge, which the objective engine uses. Custom installs can set them in the unit environment.

### Organization and reporting

Open **Agents → Organization** to choose one company leader and add teams. Each team reuses one group chat; adding an existing group keeps its conversation and members. Ordinary chat groups do not become chart branches automatically. Agents may work across several teams. Team coordinators remain optional. Company owners and admins configure the chart.

Hermes receives current reporting guidance in its session instructions: company leader, up to four of its teams, and who to report to. A team coordinator takes priority for that team's work; otherwise the company leader is the contact. Coordinators report to the company leader, and the leader reports to humans. The summary is capped at 1,100 characters. Agents can retrieve full team purposes, IDs and reporting rules with `emperor_request GET /organization`, and membership details with `GET /groups?mine=1`. Agent-bound tokens only retrieve their own team memberships.

Changing the chart does not start work or send agent messages. Existing mention routing, loop guards, task ownership, approval permissions and budgets still apply.

The Organization page can also store a reporting tree. Click a node's **+** to choose an agent or team; agent searches include their shared avatars and roles. Existing team chats can be attached as branches, or a new team can be created after selecting its AI leader. Every team requires an AI leader, and a human executive requires an AI leader somewhere beneath them. Human executives belong above AI nodes. Use **Save changes** to publish the chart and its membership/coordinator changes. Removing a branch keeps the underlying chats and memberships.

The runtime's organization consultation returns the acting agent's contextual `reporting` relationships; these take priority over the legacy flat summary. Shared agents may report to different AI leaders in different teams.
