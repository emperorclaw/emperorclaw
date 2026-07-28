# Configuration

The bridge behavior is controlled by environment variables and the bridge configuration file.

## Environment Variables

Set these in your systemd service file or shell before starting the bridge.

| Variable | Default | Description |
|----------|---------|-------------|
| `EMPEROR_CLAW_AUTO_CLAIM` | `false` | If `true`, the bridge will automatically claim tasks matching its agent profile. |
| `EMPEROR_CLAW_USE_EXECUTOR` | `false` | If `true`, the bridge will use the OpenClaw executor for task execution. |
| `EMPEROR_CLAW_MANAGER_REVIEW_MS` | `3600000` (1h) | How often Manager performs periodic reviews. Set to `0` to disable. |
| `EMPEROR_CLAW_SYNC_LOOP_MS` | `0` | Sync loop interval; set to `0` to disable periodic sync (event‑driven only). |
| `EMPEROR_CLAW_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error`. |

## Bridge Configuration File

Located at `~/.openclaw/emperor-control-plane/bridge.config.json`:

```json
{
  "agentId": "Viktor",
  "agentName": "Viktor",
  "profile": "operator",
  "mcpToken": "ec_REDACTED_EXAMPLE_TOKEN",
  "emperorUrl": "https://emperorclaw.example.com",
  "workspacePath": "/home/<user>/.openclaw/workspace-viktor",
  "memoryPath": "/home/<user>/.openclaw/emperor-control-plane/state",
  "model": "openai-codex/gpt-5.4",
  "thinking": false
}
```

### Fields

- `agentId` – Must match the agent ID in Emperor.
- `agentName` – Display name used in logs and messages.
- `profile` – `operator` (Viktor) or `manager` (Manager).
- `mcpToken` – Your Emperor MCP API token.
- `emperorUrl` – Base URL of the Emperor instance.
- `workspacePath` – OpenClaw workspace for this agent.
- `memoryPath` – Where bridge state and memory snapshots are stored.
- `model` – (Optional) LLM model override for this agent.
- `thinking` – (Optional) Enable reasoning mode.

### Agent model configuration

Emperor stores one authoritative model configuration per agent. The Agent
Details and Budget & Usage screens edit the same `llmProvider` and `llmModel`
fields; selecting a priced model updates both fields together. A disabled model
remains visible when already configured, but cannot be selected for new work.

API and MCP clients may continue sending `llmModel` alone. When the model has
one unambiguous pricing entry, Emperor infers its provider. Unknown custom
models remain supported for self-hosted runtimes.

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
WorkingDirectory=/home/<user>/.openclaw/emperor-control-plane
ExecStart=/home/<user>/.openclaw/emperor-control-plane/runtime/bridge.js
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
