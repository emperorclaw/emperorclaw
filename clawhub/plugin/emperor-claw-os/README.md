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
