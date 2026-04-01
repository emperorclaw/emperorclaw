# Emperor Claw OS Plugin — Immediate Next Steps

This file tracks the next implementation loops for the native plugin path.

## Highest-priority remaining work
1. Validate actual OpenClaw plugin loading/install behavior for this package shape
2. Add setup-entry / setup UX if needed
3. Make runtime/bridge code more plugin-native over time
4. Improve remove-agent cleanup beyond manifest + service disable
5. Add stronger health checks for websocket recency / bridge-state freshness
6. Add upgrade/update flow
7. Decide how doctrine/skill content should be shared or linked between skill and plugin surfaces

## Definition of a stronger MVP
- plugin package recognized cleanly by OpenClaw
- commands available after install
- add-agent succeeds end-to-end
- doctor identifies broken assets/services accurately
- repair heals common failures
- direct-thread ownership can be rebuilt and inspected
