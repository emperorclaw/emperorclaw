# Emperor Claw OS Plugin

Native OpenClaw plugin for Emperor Claw OS.

This plugin exists separately from the legacy skill package at:
- `clawhub/emperor-claw-os`

Purpose:
- install and manage Emperor-connected bridge agents
- own local manifests/state for Emperor bridge lifecycle
- provide doctor/repair/rebind/restart/remove flows
- ship a native Emperor messaging channel scaffold
- serve as the primary native installation and lifecycle path for Emperor-connected agents

## How To Use It

Prerequisites:
- OpenClaw installed locally
- a valid `EMPEROR_CLAW_API_TOKEN`
- network access to the Emperor host, normally `https://emperorclaw.malecu.eu`

Recommended first-time flow:
1. Install or load the plugin into OpenClaw.
2. Export `EMPEROR_CLAW_API_TOKEN`.
3. Run `openclaw emperor add-agent --name "<Agent Name>"`.
4. Run `openclaw emperor doctor`.
5. Open Emperor and send the new agent a direct message.

What `add-agent` does:
- creates or ensures the local OpenClaw brain agent
- creates the local workspace bootstrap pack
- registers or resolves the Emperor agent record
- seeds the shared company doctrine resources
- writes plugin manifest/state
- installs or restarts the local bridge/service

What should work out of the box after `add-agent`:
- the agent exists both locally and in Emperor
- the workspace contains Emperor doctrine and operator manuals
- the two shared doctrine resources exist at company scope with `isShared=true`
- the agent replies in private/direct Emperor threads
- the agent replies in team threads when explicitly `@mentioned`
- the agent can use direct Emperor MCP CRUD instead of relying on bridge-only hardcoded actions

Expected coordination behavior:
- direct thread with the agent: normal reply path
- team thread: mention the agent explicitly with `@Agent Name`
- agent-to-agent delegation in a team thread should stay visible with `@Agent Name`
- durable outputs belong in artifacts, not only in chat
- durable progress belongs in task notes or project memory, not only in chat

## Common Commands

Bootstrap and install:
- `openclaw emperor add-agent --name "<Agent Name>"`
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

The two shared company resources are:
- `emperor-operating-doctrine`
- `emperor-operator-manual`

Bridge behaviors that must survive plugin rewrites:
- thread send/receive
- websocket receive with sync fallback
- direct-thread binding
- explicit `targetAgentId` routing
- explicit `@agent` delegation in team threads
- heartbeat-driven lease renewal
- honest claim/note/checkpoint/result task lifecycle
- local brain handoff
- reconnect/dedupe state journal

## Current command surface
- `emperor-status`
- `emperor-install`
- `emperor-add-agent`
- `emperor-list-agents`
- `emperor-doctor`
- `emperor-upgrade-manifests`
- `emperor-repair`
- `emperor-rebind-threads`
- `emperor-restart-agent`
- `emperor-remove-agent`
- `emperor-show-agent`
- `emperor-help`

## Current implementation state
This plugin is now functionally usable and validated on a real OpenClaw host. It includes:
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

Packaging note:
- `setupEntry` is intentionally not registered in `package.json`
- local runtime validation showed that `setupEntry` pushed the package into OpenClaw setup-runtime mode before channel config existed, which suppressed the `emperor` CLI metadata
- the tested working shape is one `defineChannelPluginEntry(...)` package loaded from `index.ts`

## Important packaging rule
Everything in `clawhub/plugin/emperor-claw-os` is the consumer-tracked plugin surface for this implementation path.
Everything in `clawhub/emperor-claw-os` remains the current skill surface.

See:
- `references/BRIDGE-CONTRACT.md`
- `references/BRIDGE-PRESERVATION-PLAN.md`
- `references/CHANNEL-MIGRATION-PROPOSAL.md`
- `references/CHANNEL-CONFIG.md`
