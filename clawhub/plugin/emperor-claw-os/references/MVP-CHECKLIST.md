# Emperor Claw OS Plugin — MVP Checklist

## Packaging
- [x] dedicated plugin folder under `clawhub/plugin/emperor-claw-os`
- [x] `openclaw.plugin.json`
- [x] `package.json` with OpenClaw metadata
- [x] `index.ts`
- [x] `setup-entry.ts`

## Core commands
- [x] `emperor-status`
- [x] `emperor-install`
- [x] `emperor-add-agent`
- [x] `emperor-list-agents`
- [x] `emperor-doctor`
- [x] `emperor-repair`
- [x] `emperor-rebind-threads`
- [x] `emperor-restart-agent`
- [x] `emperor-remove-agent`

## State / lifecycle
- [x] local plugin config file
- [x] per-agent manifest store
- [x] thread-owner state file
- [x] workspace bootstrap generation
- [x] systemd restart path
- [x] fallback bridge launcher

## Diagnostics
- [x] doctor checks for files
- [x] doctor checks for service activity
- [x] doctor checks for bridge-state freshness
- [ ] actual plugin install/load verified in OpenClaw runtime
- [ ] end-to-end tested from plugin entrypoint rather than repo code review only

## Architecture follow-up
- [ ] reduce copied bridge/runtime duplication further
- [ ] move more runtime logic into plugin-native modules
- [x] improve remove-agent cleanup
- [ ] add upgrade/update flow

- emperor-help
