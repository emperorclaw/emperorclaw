# Emperor Claw OS — Full Plugin Implementation Plan

## Why this plan exists

OpenClaw's native plugin system is now mature enough to make Emperor Claw OS a
first-class extension instead of a shell-heavy skill installer.

This plan is based on local OpenClaw docs reviewed before writing:
- `docs/tools/plugin.md`
- `docs/plugins/building-plugins.md`
- `docs/plugins/sdk-overview.md`
- `docs/plugins/sdk-runtime.md`
- `docs/plugins/sdk-entrypoints.md`
- `docs/plugins/sdk-setup.md`
- `docs/plugins/manifest.md`
- `docs/plugins/bundles.md`

## Core conclusion

**Recommended target architecture:**
- Make a **native OpenClaw plugin** the primary delivery mechanism for Emperor operational machinery.
- Keep **consumer-distributed files tracked under `clawhub/emperor-claw-os/`**.
- Ship skill/doctrine content as part of the plugin package or adjacent package assets under the same `clawhub/*` surface.

This lets Emperor own lifecycle/bridge/runtime concerns through supported plugin APIs instead of ad-hoc generated shell glue.

---

# 1. Product goals

The plugin should make these tasks first-class and reliable:

1. Install Emperor bridge support into OpenClaw
2. Add a new Emperor-connected local agent
3. Start/manage per-agent bridge workers
4. Repair broken bridge installs
5. Diagnose broken installs with a doctor flow
6. Keep direct thread routing bound to the intended agent
7. Ship doctrine/templates/docs as versioned consumer assets
8. Support future upgrades cleanly

Non-goal for v1:
- replacing the SaaS/backend side of Emperor
- running the entire bridge purely in SaaS without local OpenClaw runtime

---

# 2. Recommended packaging model

## 2.1 Canonical shipped surface

Keep all consumer-visible distributed assets under:
- `clawhub/emperor-claw-os/`

That folder should become the canonical plugin root (or contain the plugin root payload).

## 2.2 Plugin type

Use a **native OpenClaw plugin**:
- `openclaw.plugin.json`
- `package.json` with `openclaw.extensions`
- `index.ts` plugin entry
- optional `setup-entry.ts` for lightweight onboarding/setup mode

Why native plugin and not bundle:
- bundle support is intentionally narrower
- Emperor needs services, commands, tooling, setup, and lifecycle control
- native plugin is the correct power level

## 2.3 Hybrid content model

Plugin owns:
- install/repair/doctor/add-agent/remove-agent machinery
- bridge lifecycle
- config/state/service management
- direct-thread ownership/routing logic
- upgrade hooks

Skill content owns:
- doctrine
- role templates
- examples
- references
- onboarding instructions

OpenClaw docs explicitly support plugins shipping skill directories, so this split is compatible with the platform.

---

# 3. Target plugin capabilities

## 3.1 Required plugin registrations

Using `definePluginEntry`, register:

### A. Commands
Custom commands for direct operational control:
- `emperor install`
- `emperor add-agent`
- `emperor remove-agent`
- `emperor doctor`
- `emperor repair`
- `emperor restart-agent`
- `emperor rebind-threads`
- `emperor list-agents`
- `emperor sync`

### B. Services
A background service to:
- supervise bridge workers
- watch for config drift
- optionally auto-heal dead agent bridges
- persist thread ownership and runtime state

### C. Tools
Optional or required agent tools for local agent operations, such as:
- `emperor_agent_add`
- `emperor_agent_status`
- `emperor_agent_repair`
- `emperor_agent_rebind_threads`

These let an OpenClaw agent operate Emperor setups without shelling out to random scripts.

### D. Hooks
Likely useful hooks:
- startup hook to validate installed Emperor agents/manifests/services
- message/thread related hooks where available to enforce routing safeguards
- config/health hooks to emit actionable warnings

### E. CLI registrar
Use `api.registerCli(...)` to expose proper CLI subcommands rather than hiding everything in shell scripts.

---

# 4. Canonical local data model

Move away from scattered implicit env-driven state.

## 4.1 Global plugin config

Plugin config under:
- `plugins.entries.emperor-claw-os.config`

Should hold:
- API base URL
- default runtime behavior
- default install paths
- default doctor/repair preferences
- optional company token/profile defaults

## 4.2 Per-agent manifest

Create one manifest per local Emperor-connected agent, for example:
- `~/.openclaw/emperor/agents/<slug>.json`

Example shape:

```json
{
  "agentId": "7d1f0f1d-60b2-455f-9497-4f67e4f498db",
  "agentName": "Katarína – Accountant (SK)",
  "localBrainAgentId": "katarina-accountant",
  "runtimeId": "katarina-accountant-berry5-4gb-1",
  "companionDir": "/home/jose/.openclaw/emperor-control-plane-katarina-accountant",
  "serviceName": "emperor-claw-bridge-katarina-accountant.service",
  "profile": "operator",
  "threadPolicy": {
    "direct": "bound",
    "team": "mention-required"
  },
  "installedAt": "2026-04-01T00:00:00Z",
  "version": "vNext"
}
```

This should become the source of truth instead of scattered wrapper scripts.

## 4.3 Thread ownership state

Persist thread ownership in a dedicated plugin-owned state store rather than burying it only in bridge journals.

Suggested store:
- `~/.openclaw/emperor/state/thread-owners.json`

This should support:
- direct thread → owner agent mapping
- rebinding
- diagnostics
- future migration to SaaS-side ownership enforcement

---

# 5. Runtime architecture

## 5.1 Short-term

Keep the existing Node bridge runtime, but wrap and manage it through the plugin.

That means the plugin does not need to rewrite the whole bridge immediately.
It can:
- install/generate a managed runtime bundle
- launch supervised per-agent workers
- own manifests/state
- apply routing protections centrally

## 5.2 Mid-term

Refactor the bridge into reusable internal modules:
- runtime registration
- agent resolution
- session/memory sync
- websocket transport
- thread routing policy
- local brain handoff
- checkpoint/state persistence

Then expose a thin worker launcher.

## 5.3 Long-term

Reduce dependence on generated shell scripts.

Preferred future state:
- plugin service / registered service supervises workers directly
- wrapper scripts become compatibility artifacts, not the primary control plane

---

# 6. Installation flow design

## 6.1 V1 install flow

### `emperor install`
Should:
1. validate OpenClaw/plugin environment
2. collect/configure Emperor API URL + token
3. write plugin config
4. install default skill/doctrine assets
5. optionally create the first agent
6. run doctor automatically

### `emperor add-agent`
Should:
1. validate Emperor token
2. resolve or create local OpenClaw brain agent
3. create per-agent manifest
4. materialize runtime/config files if still needed
5. create/start service or supervised worker
6. test Emperor registration + websocket connection + local brain handoff
7. return success only if end-to-end healthy

## 6.2 Setup wizard

Because OpenClaw supports `setup-entry.ts`, Emperor should provide a setup surface for:
- entering token/API URL
- choosing manager/operator profile
- first-agent creation
- detecting broken installs and offering repair

This is likely a major UX win versus raw scripts.

---

# 7. Doctor and repair design

## 7.1 `emperor doctor`

Doctor should check:
- plugin config present and valid
- API connectivity
- local manifests valid
- corresponding OpenClaw brain agents exist
- companion/runtime files present if still required
- service or supervised worker alive
- websocket connected recently
- bridge state fresh
- direct thread ownership map sane
- obvious agent cross-routing issues

Doctor output should classify:
- healthy
- degraded
- broken
- drifted

## 7.2 `emperor repair`

Repair should be safe and idempotent.

Possible repair actions:
- regenerate missing runtime files
- recreate wrapper/service units
- fix env/config drift
- reset broken thread ownership state
- restart workers
- relink manifest ↔ service ↔ local brain ids

## 7.3 `emperor rebind-threads`

Needed because multi-agent routing is a first-class concern.

Should:
- inspect recent direct threads
- infer owner from target agent metadata and/or manifest
- repair incorrect ownership mappings
- optionally clear stale ambiguous bindings

---

# 8. Direct thread routing policy

This is a critical product requirement.

## 8.1 Current safeguard

The bridge now uses:
- `targetAgentId` hints when available
- persisted `threadOwners` map for direct threads
- mention-based routing in shared/team threads

## 8.2 Preferred plugin-owned policy

Direct threads should obey this order:
1. explicit `targetAgentId`
2. existing bound owner in thread ownership state
3. explicit `@AgentName` retarget command in-thread
4. otherwise no cross-agent reply

Team/shared threads should obey:
1. explicit `@AgentName`
2. optional manager-specific orchestration rules
3. no silent ownership stealing

## 8.3 Long-term SaaS ideal

Best future shape would still be SaaS-side direct-thread ownership enforcement.
But until that exists, the plugin should own the local policy robustly.

---

# 9. Migration strategy

## Phase 0 — current baseline
- Keep the existing skill install path working
- Continue to ship fixes in `clawhub/emperor-claw-os`

## Phase 1 — plugin skeleton
Create plugin package structure under `clawhub/emperor-claw-os`:
- `openclaw.plugin.json`
- `package.json` with plugin metadata
- `index.ts`
- optional `setup-entry.ts`
- `src/` for manifest/state/doctor/install logic

## Phase 2 — command surface
Implement:
- `emperor install`
- `emperor add-agent`
- `emperor doctor`
- `emperor repair`
- `emperor list-agents`

Keep the current shell scripts as compatibility wrappers that call into the plugin where possible.

## Phase 3 — service supervision
Move worker lifecycle under plugin-managed service logic.
Reduce reliance on generated shell wrappers.

## Phase 4 — doctrine/content integration
Load role docs/templates/skill content through plugin-shipped skills and references.

## Phase 5 — deprecate legacy install path
Once plugin install is solid:
- reduce `install.sh` to compatibility/bootstrap only
- make plugin install the preferred documented path

---

# 10. Proposed plugin file layout

Suggested structure inside `clawhub/emperor-claw-os/`:

```text
clawhub/emperor-claw-os/
  openclaw.plugin.json
  package.json
  index.ts
  setup-entry.ts
  src/
    commands/
      install.ts
      add-agent.ts
      remove-agent.ts
      doctor.ts
      repair.ts
      restart-agent.ts
      rebind-threads.ts
      list-agents.ts
    runtime/
      bridge-launcher.ts
      worker-supervisor.ts
      thread-routing.ts
    state/
      manifests.ts
      thread-owners.ts
      health.ts
    install/
      bootstrap.ts
      files.ts
      services.ts
    skills/
      ...optional plugin-shipped skill roots...
  references/
  examples/
  assets/
```

If ClawHub plugin publishing prefers another exact root layout, adapt the internal structure but keep this separation of concerns.

---

# 11. MVP definition

A reasonable Emperor plugin MVP should deliver:

1. native plugin packaging recognized by OpenClaw
2. setup/install command
3. add-agent command
4. doctor command
5. repair command
6. persisted per-agent manifests
7. persisted direct-thread ownership state
8. bridge launch with correct routing policy
9. doctrine/assets still shipped under `clawhub/emperor-claw-os`

If v1 lands this, the product becomes materially easier to support than the current skill-only installer.

---

# 12. Risks and mitigations

## Risk: plugin publishing UX in ClawHub differs from assumptions
**Mitigation:** validate with a tiny proof-of-concept plugin before large migration.

## Risk: service supervision is awkward through plugin APIs alone
**Mitigation:** keep compatibility wrappers in early phases while centralizing logic in plugin modules.

## Risk: direct-thread ownership still needs SaaS cooperation
**Mitigation:** keep plugin-owned thread ownership state and rebind tools until server-side ownership exists.

## Risk: too much rewrite at once
**Mitigation:** use phased migration; stabilize current skill while introducing plugin capabilities incrementally.

---

# 13. Recommended next implementation steps

1. Build a tiny **proof-of-concept native plugin** inside `clawhub/emperor-claw-os`
   - minimal manifest
   - one command
   - one service
   - verify ClawHub/OpenClaw install path

2. Implement plugin-owned **per-agent manifest store**

3. Implement plugin-owned **doctor**

4. Move **add-agent** flow into the plugin

5. Move **thread ownership routing** under plugin-managed state

6. Keep the old installer only as a compatibility wrapper until the plugin path is proven

---

# Final recommendation

**Yes: move Emperor Claw OS toward a native OpenClaw plugin, but do it as a controlled hybrid migration.**

That gives Emperor a packaging model that matches what it really is:
not just a skill, but a managed OpenClaw extension with runtime, lifecycle, and multi-agent coordination responsibilities.
