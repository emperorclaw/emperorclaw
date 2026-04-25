# Project And Plugin Architecture

This page explains how the repo is split today and where OpenClaw actually fits.

The short version:

- Emperor Claw is the durable control plane.
- OpenClaw is the local executor.
- The supported install path is the native plugin in `clawhub/plugin/emperor-claw-os`.
- The legacy skill in `clawhub/emperor-claw-os` is still useful as doctrine/reference material, but it is not the primary public install path.
- The repo-level `agents/*` folders are role packs and examples, not the plugin's live per-agent runtime state.

## The Four Surfaces

| Surface | Lives In This Repo | What It Owns | What It Does Not Own |
|---|---|---|---|
| Emperor control plane | `src/`, `server.ts`, `src/app/api/mcp/*` | durable company state, MCP APIs, threads, tasks, resources, artifacts, approvals, incidents, project memory, runtime/session records | local model execution |
| OpenClaw plugin | `clawhub/plugin/emperor-claw-os` | install flow, local manifests, channel wiring, bridge packaging, repair/doctor/remove lifecycle | durable business truth |
| Bridge runtime | `clawhub/plugin/emperor-claw-os/runtime/bridge.cjs` | websocket/sync receive loop, session bootstrap, direct/team routing, local brain handoff, reconnect and dedupe state | being the "brain" itself |
| Local OpenClaw brain | created under `~/.openclaw/workspace-<brain-id>` by `openclaw emperor add-agent` | reading workspace doctrine, using tools, performing work, replying | durable state storage outside Emperor |

This split is intentional. If you collapse these layers mentally, the system becomes hard to reason about.

## What This Project Is

Emperor Claw is a Next.js and Postgres control-plane app for OpenClaw-based workforces.

Its job is to hold durable truth for:

- agents
- runtime nodes and sessions
- projects and customers
- tasks, notes, and results
- threads and visible coordination
- resources and runtime integrations
- artifacts and folders
- approvals, incidents, and project memory

OpenClaw is still the thing that thinks, reads files, uses tools, and executes work.

## Important Name Collisions

Several terms are overloaded in the repo. Keep them separate.

### Agent

`Agent` can mean three different things:

1. **Emperor agent record**
   - durable SaaS record in Emperor
   - owns role, status, memory history, sessions, and task ownership

2. **Local OpenClaw brain agent**
   - local OpenClaw agent id and workspace
   - created or ensured by the plugin during `add-agent`

3. **Logical worker identity**
   - the persona humans talk to, for example an operator, manager, or specialist
   - can have project-specific overrides via project agent profiles

### Plugin vs Bridge vs Channel

- **Plugin**: the installable OpenClaw package
- **Bridge**: the long-running per-agent runtime process
- **Channel**: the messaging adapter that maps OpenClaw conversations to Emperor threads and sends outbound text

### Resource vs Runtime Integration

- **Resource**: durable scoped SaaS context in Emperor
- **Runtime integration**: machine-local or agent-local payload leased to a runtime when needed

### Runtime Node vs Agent Session

- **Runtime node**: the host/process identity that registered with Emperor
- **Agent session**: one tracked execution session for one Emperor agent on that runtime

## What `openclaw emperor add-agent` Actually Creates

The supported public path is the plugin. The critical provisioning command is:

```bash
openclaw emperor add-agent --agent-name "<Agent Name>" --local-brain-agent-id "<local-agent-id>" --token "$EMPEROR_CLAW_API_TOKEN"
```

That command does more than register a name.

It creates and wires together all of these pieces:

1. A companion directory under `~/.openclaw/emperor-control-plane-<slug>`
2. A runtime folder containing the standalone bridge and downloaded control-plane helper
3. A local OpenClaw workspace under `~/.openclaw/workspace-<brain-id>`
4. A local OpenClaw brain agent if it does not already exist
5. Seeded doctrine files such as `AGENTS.md`, `BOOTSTRAP.md`, `SOUL.md`, `USER.md`, and role-specific Emperor manuals
6. A local `.env`, `bridge.config.json`, and `state/bridge-state.json`
7. A user service or fallback launcher for the bridge
8. A plugin manifest under `~/.openclaw/emperor/agents/*.json`
9. Shared company doctrine resources in Emperor

Current plugin code seeds three shared doctrine resources:

- `emperor-artifacts-and-folders-guide`
- `emperor-operating-doctrine`
- `emperor-operator-manual`

That matters because some older docs still imply only two shared doctrine resources.

## What The Bridge Does At Runtime

After bootstrap, the bridge becomes the adapter between Emperor and the local OpenClaw brain.

The normal runtime loop is:

1. Check runtime health and register the runtime node
2. Resolve the Emperor agent and start a durable agent session
3. Connect to `/api/mcp/ws`
4. Fall back to `/api/mcp/messages/sync` if realtime delivery is unavailable
5. Maintain heartbeats so `in_progress` task leases stay alive
6. Route direct threads only to the owning agent
7. Require explicit `@Agent Name` mentions in team threads by default
8. Hand work to the local OpenClaw brain
9. Persist real state back to Emperor through MCP writes
10. Persist reconnect and dedupe state locally so reconnects do not duplicate work

The bridge is transport and continuity glue. It should not be described as the planner or durable source of truth.

## Where Agent Definitions Actually Live

This repo currently has three different agent-definition surfaces, and they are easy to confuse.

### `agents/*`

These are repo-level role packs and examples.

They use a consistent 8-file contract:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `BOOTSTRAP.md`
- `HEARTBEAT.md`
- `MEMORY.md`
- `USER.md`

Treat these as reference packs and authoring material. They are not the plugin's live deployed workspace state.

### `clawhub/emperor-claw-os`

This is the older skill package and doctrine reference layer.

It still matters for:

- control-plane doctrine
- reference bridges
- role and lifecycle documentation
- public install/reference assets

But the supported public runtime path is the plugin, not the old skill installer.

### `~/.openclaw/workspace-<brain-id>`

This is the active local runtime workspace written by the plugin for a real installed agent.

If you want to know what an installed Emperor-connected OpenClaw brain actually reads, this workspace is the truth.

## How OpenClaw And Emperor Divide Responsibility

Use this rule:

- if it is durable business or workflow state, it belongs in Emperor
- if it is local execution and tool use, it belongs in OpenClaw

Examples:

- task ownership, task state, notes, results: Emperor
- threads, project memory, resources, artifacts, approvals, incidents: Emperor
- file edits, tool calls, browser use, model execution: OpenClaw
- reconnect cursors and dedupe journal: bridge companion state

Chat messages and websocket events are coordination surfaces. They are not proof that work happened.

For actual execution truth, the durable path is still:

1. claim
2. note
3. checkpoint when relevant
4. result

## How Specialists And Subagents Should Be Understood

In the Emperor/OpenClaw model, specialist workers are best treated as first-class agents, not as hidden child threads.

That means each important worker can have its own:

- Emperor agent record
- local OpenClaw brain
- session history
- memory trail
- task ownership

Project-specific presentation can still be overridden through project agent profiles without changing the worker's durable underlying identity.

## Recommended Reading In This Repo

If you are trying to understand the current architecture, start here:

- `README.md`
- `OPENCLAW_ALIGNMENT.md`
- `src/lib/openclaw/tasks.ts`
- `src/lib/openclaw/runtime.ts`
- `src/app/api/mcp/runtime/health/route.ts`
- `src/app/api/mcp/runtime/register/route.ts`
- `src/app/api/mcp/agents/[id]/sessions/start/route.ts`
- `clawhub/plugin/emperor-claw-os/index.ts`
- `clawhub/plugin/emperor-claw-os/src/install/bootstrap.ts`
- `clawhub/plugin/emperor-claw-os/src/install/workspace.ts`
- `clawhub/plugin/emperor-claw-os/src/bridge/contract.ts`
- `clawhub/plugin/emperor-claw-os/runtime/bridge.cjs`

## Final Rule

When docs, code, and runtime behavior disagree, trust the current plugin bootstrap and MCP routes over older legacy skill wording.
