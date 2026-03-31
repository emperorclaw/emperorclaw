# Configuration

The bridge behavior is controlled by environment variables and the bridge configuration file.

## Environment Variables

Set these in your systemd service file or shell before starting the bridge.

| Variable | Default | Description |
|----------|---------|-------------|
| `EMPEROR_CLAW_AUTO_CLAIM` | `false` | If `true`, the bridge will automatically claim tasks matching its agent profile. |
| `EMPEROR_CLAW_USE_EXECUTOR` | `false` | If `true`, the bridge will use the OpenClaw executor for task execution. |
| `EMPEROR_CLAW_MANAGER_REVIEW_MS` | `3600000` (1h) | How often Manager performs periodic reviews. Set to `0` to disable. |
| `EMPEROR_CLAW_SYNC_LOOP_MS` | `0` | Sync loop interval; set to `0` to disable periodic sync (event-driven only). |
| `EMPEROR_CLAW_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error`. |
| `BUNNY_STORAGE_ZONE` | *(required)* | The Bunny storage zone that holds artifact blobs (e.g., `eu-zone`). |
| `BUNNY_STORAGE_ACCESS_KEY` | *(required)* | API access key for the Bunny storage zone. |
| `BUNNY_STORAGE_HOST` | `storage.bunnycdn.com` | Optional host/region override for Bunny (or set `BUNNY_STORAGE_REGION`). |
| `BUNNY_STORAGE_PULL_ZONE_URL` | *none* | Optional public pull zone base URL (e.g., `https://storage.example.b-cdn.net`) used when generating download URLs. |

## Bridge Configuration File

Located at `~/.openclaw/emperor-control-plane/bridge.config.json`:

```json
{
  "agentId": "Viktor",
  "agentName": "Viktor",
  "profile": "operator",
  "mcpToken": "***REMOVED_TOKEN***",
  "emperorUrl": "https://emperorclaw.malecu.eu",
  "workspacePath": "/home/jose/.openclaw/workspace-viktor",
  "memoryPath": "/home/jose/.openclaw/emperor-control-plane/state",
  "model": "openai-codex/gpt-5.4",
  "thinking": false
}
```

### Fields

- `agentId` – **Required.** Must match the agent ID in Emperor. Used for:
  - Agent registration and session management
  - Filtering agent‑scoped resources (`scopeType: "agent"`, `scopeId` must match this ID)
  - Force‑sharing injection (agent‑scoped resources only inject to this agent)
- `agentName` – Display name used in logs and messages.
- `profile` – `operator` (Viktor) or `manager` (Manager).
- `mcpToken` – Your Emperor MCP API token.
- `emperorUrl` – Base URL of the Emperor instance.
- `workspacePath` – OpenClaw workspace for this agent.
- `memoryPath` – Where bridge state and memory snapshots are stored.
- `model` – (Optional) LLM model override for this agent.
- `thinking` – (Optional) Enable reasoning mode.

## Systemd Service

The installer creates a systemd user service:

**Service file:** `~/.config/systemd/user/emperor-claw-bridge.service`

```ini
[Unit]
Description=Emperor Claw bridge for OpenClaw
After=network.target

[Service]
Type=simple
Environment="EMPEROR_CLAW_AUTO_CLAIM=false"
Environment="EMPEROR_CLAW_USE_EXECUTOR=false"
Environment="EMPEROR_CLAW_SYNC_LOOP_MS=0"
WorkingDirectory=/home/jose/.openclaw/emperor-control-plane
ExecStart=/home/jose/.openclaw/emperor-control-plane/runtime/bridge.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

### Commands

```bash
# Start
systemctl --user start emperor-claw-bridge.service

# Stop
systemctl --user stop emperor-claw-bridge.service

# Status
systemctl --user status emperor-claw-bridge.service

# Logs
journalctl --user -u emperor-claw-bridge.service -f
```

## Multiple Agents

To run multiple agents (e.g., Viktor and Manager), create separate:

1. Workspace directories
2. Bridge configuration files
3. Systemd services (named `emperor-claw-bridge-viktor.service`, etc.)

Ensure each uses a unique `agentId` and `workspacePath`.
