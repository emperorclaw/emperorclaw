# Emperor Claw OS Plugin Status

This folder is no longer just a placeholder.

Current implemented surfaces:
- native OpenClaw plugin manifest/package
- plugin install/local config flow
- add-agent bootstrap
- list-agents
- doctor
- repair
- rebind-threads
- restart-agent
- remove-agent
- per-agent manifests
- plugin-owned thread owner state
- workspace bootstrap generation
- service restart + fallback launcher logic

Current architectural note:
- plugin runtime assets should increasingly come from this plugin folder itself
- existing skill package remains the compatibility/stable install surface
- plugin path is the new implementation track

## Current command surface
- emperor-status
- emperor-install
- emperor-add-agent
- emperor-list-agents
- emperor-doctor
- emperor-repair
- emperor-rebind-threads
- emperor-restart-agent
- emperor-remove-agent

- emperor-help
