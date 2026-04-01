# Emperor Claw OS Plugin

Native OpenClaw plugin implementation track for Emperor Claw OS.

This plugin exists separately from the legacy skill package at:
- `clawhub/emperor-claw-os`

Purpose:
- install and manage Emperor-connected bridge agents
- own local manifests/state for Emperor bridge lifecycle
- provide doctor/repair/rebind/restart/remove flows
- evolve toward the primary consumer installation path once proven

## Current command surface
- `emperor-status`
- `emperor-install`
- `emperor-add-agent`
- `emperor-list-agents`
- `emperor-doctor`
- `emperor-repair`
- `emperor-rebind-threads`
- `emperor-restart-agent`
- `emperor-remove-agent`

## Current implementation state
This is an active implementation track, not just a placeholder. The plugin already includes:
- native plugin manifest/package
- local config install flow
- bridge-backed add-agent bootstrap
- per-agent manifests
- plugin-owned direct-thread owner state
- workspace bootstrap generation
- service restart + fallback launch behavior
- doctor / repair / rebind lifecycle commands

## Important packaging rule
Everything in `clawhub/plugin/emperor-claw-os` is the consumer-tracked plugin surface for this implementation path.
Everything in `clawhub/emperor-claw-os` remains the current skill surface.
