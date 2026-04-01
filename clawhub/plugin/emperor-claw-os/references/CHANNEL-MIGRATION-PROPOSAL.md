# Emperor Channel Migration Proposal

## Why change the bridge shape

The current Emperor bridge was forced to do transport, routing, local-agent handoff, control-plane sync, and lifecycle management in one custom process.

OpenClaw's current plugin docs now provide a better native split:

- Channel plugins own config, security, pairing, session grammar, outbound routing, and threading.
- Core owns the shared `message` tool, prompt wiring, outer session bookkeeping, and dispatch.
- Native plugins can register channels, services, hooks, routes, commands, and tools in-process.
- Runtime helpers now expose agent workspace/session helpers and embedded local-agent execution.

Official references:

- https://docs.openclaw.ai/plugins/sdk-channel-plugins
- https://docs.openclaw.ai/plugins/architecture
- https://docs.openclaw.ai/plugins/sdk-runtime
- https://docs.openclaw.ai/tools/plugin

## Current Emperor bridge responsibilities

The existing bridge in `examples/bridge.js` currently owns:

1. Inbound transport
   WebSocket receive plus `/api/mcp/messages/sync` fallback.
2. Thread routing
   direct-thread binding, `targetAgentId`, and team-thread `@agent` rules.
3. Local brain handoff
   call the local OpenClaw agent and extract human-safe reply text.
4. Control-plane sync
   runtime register, sessions, heartbeats, task claim/result/note/checkpoint, memory, artifacts.
5. Lifecycle
   bootstrap, repair, service supervision, and local state journal.

## Proposed target split

Runtime note from local validation:
- OpenClaw `2026.3.31` can keep both channel capability and `openclaw emperor ...` CLI commands in one package.
- The important packaging constraint is that this package must not register `setupEntry`, because setup-runtime suppresses `registerCliMetadata(...)` before the Emperor channel is configured.

### 1. Emperor Messaging Channel

This becomes the native OpenClaw messaging capability.

It should own:

- session grammar for Emperor conversation ids
- outbound text/media send into Emperor threads
- direct-thread binding rules
- `targetAgentId` routing behavior
- explicit `@agent` delegation behavior for shared/team threads
- inbound message/task event subscription as a channel-managed runtime service
- local brain handoff through runtime helpers instead of shell-oriented bridge glue

Recommended OpenClaw surfaces:

- `defineChannelPluginEntry(...)`
- `createChatChannelPlugin(...)`
- `messaging.resolveSessionConversation(...)`
- `threading`
- `outbound.attachedResults.sendText(...)`
- `api.runtime.agent.ensureAgentWorkspace(...)`
- `api.runtime.agent.runEmbeddedPiAgent(...)`

### 2. Emperor Control Plugin

This stays as the general native plugin/service layer.

It should own:

- install / doctor / repair / remove-agent / restart-agent / rebind-threads
- runtime registration
- session and heartbeat lifecycle
- task claim / result / notes / checkpoint semantics
- project memory, resources, artifacts, and approvals integration
- manifest/state persistence and upgrade flows

### 3. Legacy bridge process

Keep it only as a compatibility layer during migration.

It should shrink over time to:

- fallback transport if the native channel path cannot yet replace it
- compatibility wrappers around old installs

It should stop being the main place where routing and local-agent invocation semantics live.

## What should move first

### Move now

- outbound thread send
- direct-thread ownership logic
- `@agent` routing rules
- local brain invocation wrapper

### Keep custom for now

- Emperor task truth lifecycle
- Emperor memory/resource/artifact semantics
- repair/bootstrap/install logic
- WebSocket + sync fallback transport until native channel runtime proves parity

## Recommended plugin shape

### Short term

- Keep the current `emperor-claw-os` plugin as the operational/plugin-management surface.
- Introduce an Emperor messaging module under `src/channel/` that owns routing policy and future channel adapters.
- Reuse plugin-owned manifest and thread-owner state.

### Mid term

- Add a true channel capability registration path.
- Move message send/reply and thread interpretation into the channel.
- Replace shell-driven local brain handoff with runtime-backed execution.

### Long term

- Keep the control plane plugin and messaging channel in the same package while that remains operationally simple.
- Only split if a later setup/runtime constraint forces it.

## Acceptance bar

Migration is only acceptable if all of these still work:

1. Direct threads reply to the bound agent.
2. Team threads require explicit `@agent` by default.
3. `targetAgentId` routes correctly.
4. WebSocket inbound works.
5. `/messages/sync` fallback works.
6. Local agent handoff works.
7. Claim/note/checkpoint/result truth stays aligned with Emperor state.
8. Reconnect/dedupe behavior does not replay the same work.

## Immediate implementation direction

1. Keep current bridge semantics as the source of truth.
2. Extract routing policy into plugin-owned pure modules under `src/channel/`.
3. Add validation for actual send/receive and direct-thread binding behavior.
4. Only then replace the old hacked transport pieces with native channel capability code.

## Progress now landed

The plugin package now includes:

- `openclaw.channel` metadata in `package.json`
- a tested `defineChannelPluginEntry(...)` package in `index.ts`
- an unregistered `setup-entry.ts` kept only as a future helper
- `src/channel/config.ts` for `channels.emperor` config resolution
- `src/channel/session-conversation.ts` plus top-level `session-key-api.ts`
- `src/channel/outbound.ts` for native outbound send mapping
- `src/channel/brain-handoff.ts` for runtime-helper-based local brain handoff

That means the remaining work is no longer "design a native channel". The remaining work is:

1. inbound Emperor event delivery
2. runtime-backed brain execution in place of shell CLI handoff
3. end-to-end parity validation against the current bridge
