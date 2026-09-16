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
| `BUNNY_STORAGE_ZONE` | *(none)* | Bunny storage zone for CDN-backed storage. Only needed when `STORAGE_BACKEND=bunny`. |
| `BUNNY_STORAGE_ACCESS_KEY` | *(none)* | API access key for the Bunny storage zone. Only needed when `STORAGE_BACKEND=bunny`. |
| `BUNNY_STORAGE_HOST` | `storage.bunnycdn.com` | Optional host/region override for Bunny (or set `BUNNY_STORAGE_REGION`). |
| `BUNNY_STORAGE_PULL_ZONE_URL` | *none* | Optional public pull zone base URL (e.g., `https://storage.example.b-cdn.net`) used when generating download URLs. |

## Bridge Configuration File

Located at `~/.openclaw/emperor-control-plane/bridge.config.json`:

```json
{
  "agentId": "Viktor",
  "agentName": "Viktor",
  "profile": "operator",
  "mcpToken": "<your-mcp-token>",
  "emperorUrl": "https://emperorclaw.example.com",
  "workspacePath": "/home/<user>/.openclaw/workspace-viktor",
  "memoryPath": "/home/<user>/.openclaw/emperor-control-plane/state",
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

## Agent Reasoning in the Typing Indicator

While an agent is working, the chat shows a live activity line next to the
typing indicator. The bridge fills it with the most specific thing it actually
knows: the model's real reasoning, otherwise the current tool call, otherwise
plain elapsed time (`working (42s)`). It never invents a "thinking" state it
cannot observe — if the runtime exposes no reasoning, you see elapsed time.

When real reasoning is available the line is prefixed `thinking:` so it is
unambiguous that you are reading the model's own words rather than a bridge
description of a tool call.

### `EMPEROR_CLAW_REASONING_SOURCE`

| Value | Behavior |
|-------|----------|
| `auto` *(default)* | Use `session-store` when `$HERMES_HOME/state.db` exists and is readable, otherwise `none`. Re-checked about once a minute, so a store created after the bridge started is picked up without a restart. |
| `session-store` | Read reasoning from the Hermes session store at `$HERMES_HOME/state.db`. |
| `none` | Never report reasoning. The correct setting for any runtime that does not expose it — fully supported, not a degraded mode. |

### Safety

The `session-store` reader opens `state.db` through SQLite's read-only URI mode
(`mode=ro`) with a short busy timeout. It never writes, never migrates and never
creates the file — it is another running program's live database. A locked,
busy, missing, corrupt or schema-shifted database is treated as "no reasoning
this tick", never as a turn failure. Columns are probed with
`PRAGMA table_info(messages)` rather than assumed, so a Hermes schema bump
degrades quietly instead of erroring.

Reads are always scoped to the Hermes session id of the current thread. A
reasoning row belonging to another session is never shown, so agents sharing one
`HERMES_HOME` cannot leak each other's reasoning into a thread.

### Privacy

Reasoning is raw model output. It can quote the user verbatim, and it can
contain file paths, command output or credentials that appeared in context.
Treat the activity line as sensitive to anyone who can see the thread.

It is condensed to a single line (~160 chars), truncated again to 200 chars
server-side, and cleared as soon as typing stops. This feature persists no
reasoning anywhere — there is no transcript, no column and no history. Set
`EMPEROR_CLAW_REASONING_SOURCE=none` to turn it off entirely.

### Adding your own runtime

Reasoning is read through a small interface in
`integrations/hermes/emperor-claw/bridge/emperor_hermes_bridge.py`:

```python
class ReasoningSource:
    name = "none"

    def latest_reasoning(self, session_id: str, since_ts: float) -> str | None:
        """Short, already-condensed reasoning line, or None. Must never raise."""
```

Implement one class for your runtime, return `condense_reasoning(raw_text)`, and
register it in `_build_reasoning_source()` under a new
`EMPEROR_CLAW_REASONING_SOURCE` value. It is called about every 3 seconds during
a turn, so it must be cheap and non-blocking, and it must scope reads to
`session_id` so one agent never surfaces another's reasoning.
