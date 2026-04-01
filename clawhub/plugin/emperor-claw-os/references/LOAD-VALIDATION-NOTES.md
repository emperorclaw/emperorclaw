# Emperor Claw OS Plugin - Load Validation Notes

## Structural checks completed
- native manifest exists: `openclaw.plugin.json`
- package metadata includes `openclaw.extensions`
- plugin entry exists: `index.ts`
- setup helper exists: `setup-entry.ts` (not currently registered)
- local TS config added for editor/tooling sanity

## Runtime validation completed on local OpenClaw

Validated against local OpenClaw `2026.3.31` on `2026-04-01` using an isolated profile:
- profile: `~/.openclaw-emperor-plugin-test`
- Node runtime used for CLI: `22.15.0`

Observed behavior:

1. Plain plugin shape loaded successfully as a normal plugin.
   - Commands were visible.
   - Channel capability was not recognized.

2. A separate `channel-entry.ts` did not produce a second capability entry.
   - OpenClaw still treated the package as a plain non-channel plugin.

3. Converting `index.ts` to `defineChannelPluginEntry(...)` plus declaring `channels` in `openclaw.plugin.json` made the package channel-aware.
   - Initial attempt failed because the package/plugin id was `emperor-claw-os` while the setup-exported channel plugin id was `emperor`.
   - OpenClaw rejected that with:
     `plugin id mismatch (config uses "emperor-claw-os", setup export uses "emperor")`

4. Aligning the package id and channel id to `emperor-claw-os` fixed channel loading.
   - `plugins inspect emperor-claw-os --json` reported:
     - `status: loaded`
     - `shape: plain-capability`
     - `capabilities: channel: emperor-claw-os`
   - `plugins doctor` reported no plugin issues.

5. Registering `openclaw.setupEntry` caused a real loader regression for this package shape.
   - Because the Emperor channel is not configured on first install, OpenClaw loaded the package in setup-runtime mode.
   - In setup-runtime mode, `defineChannelPluginEntry(...)` skips `registerCliMetadata(...)`.
   - Result: `openclaw emperor ...` disappeared even though the channel capability loaded.

6. Removing `setupEntry` from `package.json` fixed the package shape.
   - The same package now exposes:
     - channel capability `emperor-claw-os`
     - CLI command `emperor`
     - plugin commands like `emperor-status`, `emperor-doctor`, `emperor-add-agent`
   - `openclaw emperor help` works in the isolated profile.
   - `plugins inspect emperor-claw-os --json` shows both `channelIds` and `cliCommands`.

## Current conclusion

The tested local package shape is:

- one `defineChannelPluginEntry(...)` package
- no registered `setupEntry`
- channel capability declared in `openclaw.plugin.json`
- lifecycle/control CLI retained through `registerCliMetadata(...)`

This is currently the cleanest tested path for keeping both:
- native Emperor channel capability
- native `openclaw emperor ...` lifecycle commands

## Live Emperor validation completed

Validated on Windows against the live Emperor host on `2026-04-01`:
- Emperor host: `https://emperorclaw.malecu.eu`
- isolated OpenClaw profile: `~/.openclaw-emperor-plugin-test`
- local test agent:
  - local brain id: `plugin-validation-agent`
  - runtime id: `plugin-validation-agent-fifufire`
  - Emperor agent id: `c9a05156-3b25-44e3-bca6-6492dec2a2eb`

Observed behavior:

1. Direct authenticated Emperor API validation succeeded.
   - `/api/mcp/agents?limit=1` returned `200` with a real token.

2. `scripts/control-plane.js doctor` succeeded against the live host.
   - token validation passed
   - websocket connected
   - runtime registration passed
   - session start / heartbeat / checkpoint / session end passed
   - thread message send plus websocket fanout passed

3. `openclaw emperor add-agent ...` now succeeds on Windows.
   - a real manifest was written under `~/.openclaw/emperor/agents`
   - the companion runtime was created under `~/.openclaw/emperor-control-plane-plugin-validation-agent`
   - the local OpenClaw brain agent was created successfully

4. Windows fallback bridge launch now works without WSL or Git Bash.
   - the plugin writes `run-bridge.ps1` on Windows
   - fallback launch now uses a detached PowerShell `Start-Process` path
   - `bridge-state.json` updates after the CLI exits, proving the bridge remains alive

5. `openclaw emperor doctor` is green for the tracked Windows agent.
   - Emperor reachability: ok
   - Emperor auth: ok
   - bridge state present and fresh: ok
   - service check now reports fallback bridge health on `win32` instead of falsely failing on missing `systemd`

6. Emperor sees the test agent online.
   - direct authenticated agent lookup returned:
     - `status: online`
     - `lastSeenAt` updated from the live bridge session

Residual note:
- the isolated OpenClaw profile still warns about a stale `plugins.entries.emperor-claw-os` config entry and empty `plugins.allow`
- those warnings do not block plugin loading, bootstrap, doctor, or live bridge connectivity
