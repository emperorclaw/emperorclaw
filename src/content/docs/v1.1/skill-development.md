# Plugin And Agent Development

This page describes the current supported extension model around Emperor and OpenClaw.

## Current Public Model

The supported integration path is the **plugin**, not the legacy skill package.

Use the plugin when you want:

- local agent bootstrap
- bridge lifecycle management
- doctrine seeding
- repair and doctor flows
- Emperor-connected runtime behavior

## Legacy Skill Note

Older Emperor materials may still mention a separate skill-based package. That still exists historically, but it is no longer the primary public install path.

For current users, the supported surface is:

```bash
openclaw plugins install clawhub:@malecu/emperor-claw-os-plugin
```

## What The Plugin Owns

The plugin is responsible for:

- local bridge/runtime assets
- agent bootstrap
- workspace doctrine files
- repair/restart flows
- Emperor/OpenClaw glue behavior

## How OpenClaw Actually Reads Agent Doctrine

The plugin should teach agents through the OpenClaw workspace model, not through vague prose.

Important current runtime facts:

- OpenClaw injects recognized workspace files such as `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, and `BOOTSTRAP.md`
- `AGENTS.md` sections named `Session Startup` and `Red Lines` are the safest place for critical rules that must survive compaction
- `BOOTSTRAP.md` should define the exact startup reading order
- `SOUL.md` should carry persona and tone, not durable operational truth
- Emperor should remain the source of truth for tasks, notes, memory, resources, artifacts, and threads

Read the dedicated guide here:

- [OpenClaw Agent Runtime](/docs/v1.1/openclaw-agents)

## What Emperor Owns

Emperor owns the durable operational state:

- tasks
- approvals
- incidents
- resources
- artifacts
- threads
- project memory

## Watchdogs And Incidents

The current watchdog logic belongs in Emperor, not in the plugin.

Why:

- incidents are durable control-plane records
- lease expiry and SLA logic depend on canonical Emperor task state
- all users should see the same incident behavior from the same source of truth

Today those watchdog rules are mostly fixed defaults in the server:

- lease expiry can retry a task until `maxRetries`
- dead-lettering after max retries raises an incident
- SLA breach on tracked task states raises an incident

This is acceptable for launch as long as it is documented clearly.

Plugin-side checks can still exist for local runtime health, but the canonical watchdog that mutates task/incident state should stay in Emperor.
