# Emperor Claw OS Plugin Bridge Preservation Plan

## Goal

Migrate from the working skill-era bridge packaging to the native plugin path without losing the behaviors that make Emperor-connected agents operational.

## Must preserve first

1. Thread send/receive.
2. Direct-thread ownership and rebind behavior.
3. Explicit `@agent` delegation in team threads.
4. `targetAgentId` routing for direct delivery.
5. Heartbeat and lease renewal.
6. Honest claim, note, checkpoint, and result lifecycle.
7. Local brain handoff.
8. Reconnect, sync fallback, and dedupe state.

## Execution order

### Phase 1
- Make the bridge contract explicit in plugin-owned docs and manifest state.
- Make doctor and status report whether tracked agents preserve that contract.
- Keep using the current bridge runtime while this hardening lands.

### Phase 2
- Make validation deterministic and self-cleaning.
- Prove end-to-end plugin install, add-agent, message send/receive, and teardown on a real host.
- Treat that validation as the acceptance bar for future plugin changes.

### Phase 3
- Refactor the bridge launcher and supervision model if desired.
- Keep the contract and validation stable while internals change.

## Non-goal

Rewriting the bridge internals before the preserved behaviors are explicitly tracked and validated.
