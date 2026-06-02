# Changelog

## 0.2.3

- shortened the default long-turn acknowledgement to `...`

## 0.2.2

- fixed compiled plugin path resolution so repair/status can find root runtime and manifest assets

## 0.2.1

- fixed native inbound direct-thread replies so human sender IDs are not sent back as agent targets
- fixed direct-thread rebind repair to use the supported `type=direct` thread filter

## 0.2.0

- added native `emperor-inbound` service — OpenClaw now handles Emperor WebSocket + sync-fallback transport in-process; no separate bridge process needed for message delivery
- replaced shell-based brain handoff with `runtime.agent.runEmbeddedPiAgent` — brain runs inside the OpenClaw daemon, no subprocess spawn per message
- fixed Windows fallback bridge launcher: replaced `Start-Process powershell -ExecutionPolicy Bypass -WindowStyle Hidden` with a direct `node.exe` spawn — eliminates the AV/Defender detection signature
- fixed `bootstrap.ts`: replaced `execSync curl` + `chmod 755` on JS files with native `fetch` — eliminates remote-download-and-execute detection pattern
- wired `setRuntime` in `index.ts` so the plugin runtime is available to the inbound service before the first message arrives

## 0.1.9

- added a dedicated OpenClaw agent runtime doctrine guide for Emperor-connected agents
- rewrote the seeded workspace bootstrap to emphasize `AGENTS.md` compaction-safe `Session Startup` and `Red Lines` sections
- updated `BOOTSTRAP.md` generation so agents keep the Emperor startup sequence instead of treating bootstrap as disposable
- expanded the public API reference and plugin development docs with clearer OpenClaw runtime examples and instruction placement guidance
