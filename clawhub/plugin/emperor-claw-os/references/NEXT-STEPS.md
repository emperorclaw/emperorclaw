# Emperor Claw OS Plugin — Immediate Next Steps

This file tracks the next implementation loops for the native plugin path.

## Highest-priority remaining work
1. Make local validation fully deterministic and self-cleaning across repeated runs
2. Clean up the local OpenClaw profile warnings (`plugins.allow`, stale `plugins.entries.emperor-claw-os`)
3. Finish the native Emperor messaging channel by wiring inbound transport and event delivery
4. Replace shell-based local brain handoff with `api.runtime.agent.runEmbeddedPiAgent(...)`
5. Extend validation to assert channel-based message send/receive and direct-thread binding behavior
6. Add stronger health checks for websocket recency / bridge-state freshness
7. Add setup UX only if a concrete setup-runtime need appears that does not suppress CLI metadata
8. Add upgrade/update flow
9. Make runtime/bridge code more plugin-native over time

## Definition of a stronger MVP
- plugin package recognized cleanly by OpenClaw
- tested answer for whether commands and channel capability can coexist in one package
- add-agent succeeds end-to-end
- add-agent and restart-agent succeed on Windows without WSL/Git Bash
- Emperor doctor can prove authenticated host connectivity
- the fallback bridge stays alive after CLI exit and updates bridge-state freshness
- doctor identifies broken assets/services accurately
- repair heals common failures
- direct-thread ownership can be rebuilt and inspected
