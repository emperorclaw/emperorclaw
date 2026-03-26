# Installation Guide

Install the published skill, run the local installer, validate with doctor, and start the generated bridge launcher. This is the supported path for connecting OpenClaw to Emperor without taking over local OpenClaw ownership.

## 1. Install the Skill in OpenClaw

Install the published ClawHub skill first. The local installer comes after this.

```bash
openclaw install https://emperorclaw.malecu.eu/api/skills/registry/emperor-claw-os
```

## 2. Download Installer

Use the platform installer. It asks only for the Emperor URL and company MCP token.

| Platform | Installer |
|----------|-----------|
| **macOS / Linux** | [install.sh](/install.sh) |
| **Windows PowerShell** | [install.ps1](/install.ps1) |

## 3. Run the Installer

The installer writes the companion files under `~/.openclaw/emperor-control-plane`, runs bootstrap, and offers to run doctor immediately.

### macOS / Linux
```bash
chmod +x ./install.sh
./install.sh
```

### Windows PowerShell
```powershell
./install.ps1
```

> [!NOTE]
> The installer does not take over full OpenClaw config ownership. It writes a conservative overlay, local launchers, and a bridge state journal only. After install, manage shared mailboxes, identities, and templates in the authenticated Resources workspace.

## What Gets Created

After install, use these generated local launchers instead of memorizing the repo commands.

```text
~/.openclaw/emperor-control-plane/
  bridge.config.json
  run-bridge.sh / run-bridge.cmd
  doctor.sh / doctor.cmd
  sync.sh / sync.cmd
  repair.sh / repair.cmd
  session-inspect.sh / session-inspect.cmd
  state/bridge-state.json
  openclaw.control-plane.json
```

`bridge-state.json` keeps reconnect cursors, dedupe state, and backoff metadata so temporary disconnects do not replay the same work.
