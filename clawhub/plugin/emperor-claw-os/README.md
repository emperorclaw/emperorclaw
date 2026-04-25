# Emperor Claw OS Plugin

Native OpenClaw plugin for Emperor Claw OS.

This package installs and manages Emperor-connected OpenClaw agents. It is the native plugin path for:
- local agent bootstrap
- Emperor bridge lifecycle
- scoped doctrine seeding
- repair / doctor / restart flows
- Emperor messaging channel integration

The legacy skill package still exists separately at:
- `clawhub/emperor-claw-os`

## What It Gives You

- a local OpenClaw brain agent plus an Emperor agent record
- a standalone bridge runtime copied into a per-agent companion directory
- seeded doctrine and operator manuals
- shared company doctrine resources in Emperor
- direct thread replies and team-thread `@Agent Name` routing
- maintenance commands for repair, rebind, restart, removal, and diagnostics

## Install

Prerequisites:
- OpenClaw installed locally
- a valid `EMPEROR_CLAW_API_TOKEN`
- network access to the Emperor host, normally `https://emperorclaw.malecu.eu`

Recommended first-time flow:

```bash
openclaw plugins install clawhub:@malecu/emperor-claw-os-plugin
```

Then:

```bash
export EMPEROR_CLAW_API_TOKEN="<company-token>"
openclaw emperor add-agent --agent-name "<Agent Name>" --local-brain-agent-id "<local-agent-id>" --token "$EMPEROR_CLAW_API_TOKEN"
openclaw emperor doctor
```

Then open Emperor and send the new agent a direct message.

What `add-agent` does:
- creates or ensures the local OpenClaw brain agent
- creates the local workspace bootstrap pack
- registers or resolves the Emperor agent record
- seeds the shared company doctrine resources
- writes plugin manifest/state
- installs or restarts the local bridge/service

After `add-agent`, the expected baseline is:
- the agent exists both locally and in Emperor
- the workspace contains Emperor doctrine and operator manuals
- the two shared doctrine resources exist at company scope with `isShared=true`
- the agent replies in private/direct Emperor threads
- the agent replies in team threads when explicitly `@mentioned`
- the agent can use direct Emperor MCP CRUD instead of relying on bridge-only hardcoded actions

## Coordination Model

- direct thread with the agent: normal reply path
- team thread: mention the agent explicitly with `@Agent Name`
- agent-to-agent delegation in a team thread should stay visible with `@Agent Name`
- durable outputs belong in artifacts, not only in chat
- durable progress belongs in task notes or project memory, not only in chat

## Commands

Bootstrap and install:
- `openclaw emperor add-agent --agent-name "<Agent Name>" --local-brain-agent-id "<local-agent-id>" --token "<company-token>"`
- `openclaw emperor status`
- `openclaw emperor doctor`

Maintenance:
- `openclaw emperor repair`
- `openclaw emperor restart-agent --agent "<Agent Name>"`
- `openclaw emperor rebind-threads --agent "<Agent Name>"`
- `openclaw emperor remove-agent --agent "<Agent Name>"`
- `openclaw emperor show-agent --agent "<Agent Name>"`

Validation:
- `scripts/validate-local.sh`

## Seeded Doctrine

New operator workspaces are seeded with human-readable manuals that teach the agent how to operate Emperor:
- object model and operating doctrine
- direct MCP usage
- customers, projects, tasks, memory, resources, artifacts, folders, approvals, incidents, schedules
- endpoint choice guidance
- direct-thread vs team-thread behavior
- visible `@agentname` delegation
- resource sharing semantics, including agent-scoped shared resources
- worked write patterns and end-to-end execution flows

The shared company resources are:
- `emperor-artifacts-and-folders-guide`
- `emperor-operating-doctrine`
- `emperor-operator-manual`

## Bridge Contract

These behaviors are expected to survive future rewrites:
- thread send/receive
- websocket receive with sync fallback
- direct-thread binding
- explicit `targetAgentId` routing
- explicit `@agent` delegation in team threads
- heartbeat-driven lease renewal
- honest claim/note/checkpoint/result task lifecycle
- local brain handoff
- reconnect/dedupe state journal

## Runtime Layout

The runtime-critical bridge is shipped as a standalone CommonJS runtime under:
- `runtime/bridge.cjs`

The plugin lifecycle/control code remains TypeScript under:
- `src/`

That split exists because the bridge is copied into companion directories and executed directly by Node as a standalone runtime script.

## Bridge Logs

Each companion runtime now writes structured bridge logs by default:
- JSONL file: `logs/bridge-events.jsonl` under the agent companion directory
- fallback process output: `bridge-fallback.log`

Useful environment variables:
- `EMPEROR_CLAW_LOG_LEVEL=info|debug|warn|error`
- `EMPEROR_CLAW_LOG_FORMAT=jsonl`
- `EMPEROR_CLAW_LOG_PROMPTS=false|true`
- `EMPEROR_CLAW_BRAIN_MODE=auto|gateway-cli|local-cli`

The structured log is meant for debugging:
- wake/skip reasons
- direct-thread ownership failures
- local brain invocation lifecycle
- long-turn notices
- final reply send attempts

Prompt logging stays off by default.

Brain mode behavior:
- `auto` prefers the normal Gateway-backed `openclaw agent` path first
- if the Gateway path is unavailable, `auto` falls back to `openclaw agent --local`
- `gateway-cli` forces the Gateway-backed path
- `local-cli` forces the local embedded CLI path

## Implementation Notes

This plugin is functionally usable and validated on a real OpenClaw host. It includes:
- native plugin manifest/package
- native channel package metadata (`openclaw.channel`)
- channel declaration in `openclaw.plugin.json`
- a single tested package shape that preserves both `openclaw emperor ...` CLI commands and the Emperor channel capability
- local config install flow
- bridge-backed add-agent bootstrap
- per-agent manifests
- plugin-owned direct-thread owner state
- workspace bootstrap generation
- service restart + fallback launch behavior
- doctor / repair / rebind lifecycle commands
- channel-owned session grammar and outbound send scaffolding under `src/channel/`
- local end-to-end validation script (`scripts/validate-local.sh`)

## Update Existing Installs

```bash
openclaw plugins update emperor-claw-os
openclaw emperor repair
```

If manifest shape changes:

```bash
openclaw emperor upgrade-manifests
```

## Validation

The plugin has been validated both by local build checks and by live Emperor-connected inbox tests.

Useful checks:
- `npm run build`
- `node --check runtime/bridge.cjs`
- `scripts/validate-local.sh`
- `references/USER-E2E-TEST-PLAN.md`

## Contributing

See `CONTRIBUTING.md`.

See:
- `references/BRIDGE-CONTRACT.md`
- `references/BRIDGE-PRESERVATION-PLAN.md`
- `references/CHANNEL-MIGRATION-PROPOSAL.md`
- `references/CHANNEL-CONFIG.md`
