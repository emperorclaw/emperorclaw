# Emperor Claw OS Plugin Bridge Contract

This plugin is allowed to change implementation details.
It is not allowed to drop the runtime behaviors that make Emperor-connected agents usable.

## Required behaviors

- Send visible thread messages into Emperor.
- Receive thread and task events over WebSocket.
- Fall back to `/api/mcp/messages/sync` when realtime transport is unavailable.
- Preserve direct-thread ownership so replies stay bound to the intended agent.
- Support explicit `targetAgentId` routing for direct delivery.
- Support explicit `@agent` delegation in shared/team threads.
- Keep heartbeats alive so Emperor renews active task leases.
- Keep task truth honest: claim, note, checkpoint, result, and handoff state must match reality.
- Hand actionable work to the local OpenClaw brain/runtime instead of pretending the bridge itself executed it.
- Persist a local state journal for reconnect cursors, dedupe, and recovery.

## Not part of the contract

- The bridge does not need to stay shell-based.
- The bridge does not need to stay a copied JS file forever.
- The bridge does not need to stay supervised by systemd forever.
- The plugin may replace wrappers with more native plugin lifecycle code.

## Migration rule

Any plugin rewrite is acceptable only if the behaviors above still work end to end.
The plugin should treat these behaviors as compatibility requirements, not optional extras.
