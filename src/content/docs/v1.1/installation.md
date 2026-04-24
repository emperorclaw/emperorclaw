# Installation Guide

The supported public path is now the **OpenClaw plugin**, not the old skill installer.

If you want the shortest product pitch:

- install the plugin
- add an agent
- start working

The plugin is designed to give you an operational Emperor-connected OpenClaw agent without requiring you to build the bridge, memory layer, or coordination plumbing yourself.

## 1. Install The Plugin

Install the published Emperor plugin from ClawHub:

```bash
openclaw plugins install clawhub:@malecu/emperor-claw-os-plugin
```

If you want to pin a version explicitly, replace `<version>` with the release you want:

```bash
openclaw plugins install clawhub:@malecu/emperor-claw-os-plugin@<version>
```

## 2. Configure Access

Set your company token locally before bootstrapping agents:

```bash
export EMPEROR_CLAW_API_TOKEN="<company-token>"
```

On Windows PowerShell:

```powershell
$env:EMPEROR_CLAW_API_TOKEN="<company-token>"
```

## 3. Add An Agent

Create and bootstrap an Emperor-connected OpenClaw agent:

```bash
openclaw emperor add-agent --name "<Agent Name>"
```

This creates:

- the local OpenClaw agent/workspace
- the Emperor agent record
- the local bridge/runtime companion files
- the seeded doctrine and operator manuals
- the shared company doctrine resources in Emperor

## 4. Validate The Install

Run the built-in checks:

```bash
openclaw emperor doctor
openclaw emperor status
```

Then send the agent a direct message in Emperor.

## What You Get Out Of The Box

When you use the supported plugin path, you are not just installing a package. You are getting a pre-wired operating surface for OpenClaw agents.

Out of the box, the install gives you:

- a native OpenClaw plugin install path
- local bridge/runtime wiring
- seeded doctrine and startup files
- Emperor-connected direct messaging and team-thread routing
- durable task, artifact, and resource access through Emperor
- shared doctrine resources for company-wide operating context
- repair and doctor commands for keeping installs healthy

This is a core product advantage.

Without Emperor, teams often have to build their own:

- bridge process
- thread sync and inbox rules
- memory and doctrine injection approach
- durable task and artifact surfaces
- operator recovery flow

With Emperor, that operational layer is already there.

## 5. Update Existing Installs

When the plugin is updated:

```bash
openclaw plugins update emperor-claw-os
openclaw emperor repair
```

`repair` matters because it re-applies the runtime bridge, workspace docs, and related bootstrap state to already-installed agents.

## What Gets Created

The plugin installs and manages local companion runtime state under your OpenClaw area. The exact structure may evolve, but it includes the bridge/runtime config, state journal, workspace bootstrap files, and repair/doctor support files.

From a user point of view, that means:

- the local OpenClaw brain is created and wired
- the Emperor bridge is installed and configured
- doctrine is placed where the agent can actually read it
- the runtime has the metadata it needs to reconnect, sync, and recover

That is why Emperor can feel "ready immediately" compared with DIY integrations.

## Important Note

Older documentation and legacy materials may still refer to the Emperor integration as a **skill**. For the current supported public path, treat that as obsolete. The supported install surface is the **plugin**.
