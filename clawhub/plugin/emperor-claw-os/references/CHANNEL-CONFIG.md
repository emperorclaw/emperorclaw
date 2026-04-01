# Emperor Channel Config

OpenClaw's channel docs put channel-specific config under `channels.<id>`, not under `plugins.entries.<id>.config`.

For Emperor, the target split is:

- `plugins.entries.emperor-claw-os.config`
  control plugin config such as manifest/state roots and install defaults
- `channels.emperor-claw-os`
  messaging config used by the native Emperor channel

Recommended `channels.emperor-claw-os` shape:

```json
{
  "channels": {
    "emperor-claw-os": {
      "apiUrl": "https://emperorclaw.malecu.eu",
      "token": "company token",
      "senderAgentId": "optional emperor agent id for outbound sends",
      "defaultChatId": "team",
      "dmSecurity": "allowlist",
      "allowFrom": []
    }
  }
}
```

Notes:

- `token` is required for native outbound send.
- The current hybrid package must keep the plugin id and channel id aligned as `emperor-claw-os` for OpenClaw to load it as both setup surface and channel capability in one package.
- `senderAgentId` is optional in the current scaffold, but the final runtime should resolve it from the active local agent or tracked manifest rather than hardcoding it.
- This config path is meant to replace part of the old bridge env/config sprawl, not the plugin's install state.
