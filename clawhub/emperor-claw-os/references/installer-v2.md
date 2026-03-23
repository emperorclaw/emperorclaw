# Installer v2 Notes

This companion installer should provision a working Emperor ↔ OpenClaw bridge without requiring manual post-install repair.

## Required behavior

1. Default `EMPEROR_CLAW_API_URL` to `https://emperorclaw.malecu.eu`.
2. Download the current `control-plane.js` and `bridge.js` runtime files.
3. Install runtime dependencies automatically (`ws` at minimum) or ship bundled standalone files.
4. Bootstrap a per-agent companion directory under `~/.openclaw/` (for example `emperor-control-plane-viktor` or `emperor-control-plane-manager`).
5. Create a dedicated local OpenClaw agent for the Emperor-facing assistant instead of reusing `main`.
6. Overwrite the generic fresh-workspace bootstrap with an Emperor-aware bootstrap pack (`BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`, and Emperor operating rules in `AGENTS.md`).
7. Seed that local agent identity (for example `Viktor`) and owner context.
8. Persist secrets in `~/.openclaw/emperor-control-plane/.env` with restrictive permissions.
9. Install a persistent per-agent `systemd --user` service when available.
10. Provide simple wrappers for common profiles like manager (for example `scripts/install-manager.sh`).
11. Run a post-install doctor flow plus a local OpenClaw brain smoke test.

## Recommended defaults

- Support `EMPEROR_CLAW_AGENT_PROFILE=operator|manager`.
- Team thread behavior for operator: reply only when explicitly mentioned.
- Direct thread behavior for operator: auto-reply without requiring an explicit mention.
- Manager profile: emphasize summaries, stale-task detection, and non-noisy oversight.
- Local brain handoff: use a dedicated OpenClaw agent id such as `viktor` or `manager`.
- Reply extraction: parse only `result.payloads[].text` (plus minimal plain-text fallbacks) from `openclaw agent --json` output. Never send the full JSON envelope to Emperor chat.

## Why this matters

Without these defaults, first-time users can hit:
- missing `ws` runtime dependency
- wrong API base URL (`localhost`)
- duplicate or non-persistent bridge launches
- leaked replies into the `main` OpenClaw session
- raw JSON blobs posted back into Emperor threads
- silence in direct agent threads because the bridge only checks for mentions

## Companion responsibility split

- `install.sh`: provision runtime, local brain agent, env file, and service.
- `control-plane.js bootstrap`: write consistent wrappers/config.
- `bridge.js`: enforce thread routing rules, local brain handoff, and clean reply extraction.
