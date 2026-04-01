# Emperor Claw OS — Skill vs Plugin Migration Assessment

## Context

Jose clarified the packaging boundary:
- Everything under `clawhub/*` is the **consumer-distributed surface** exposed through ClawHub.
- Everything outside `clawhub/*` is the **SaaS/product repo** side.
- Emperor is usually installed as a **skill**, so shipped bridge/runtime/install files must be tracked inside `clawhub/emperor-claw-os/`.
- ClawHub now appears to support **plugins** too, which may offer a cleaner operational model than a shell-heavy skill installer.

## What OpenClaw supports today

Based on local OpenClaw docs:
- OpenClaw supports **native plugins** via `openclaw.plugin.json` + runtime module.
- Users can install plugins with `openclaw plugins install <package>`.
- Plugins can register tools, hooks, services, CLI commands, HTTP routes, providers, channels, and skills.
- Plugins can also ship **skills** via manifest metadata (`skills` in `openclaw.plugin.json`).
- OpenClaw also supports **bundle** formats (Codex/Claude/Cursor), but bundles are narrower and not as powerful as native plugins.

## Current Emperor Claw OS shape

Current ClawHub package (`clawhub/emperor-claw-os`) behaves like more than a pure skill:
- installs runtime JS files
- generates env/config/service wrappers
- creates local OpenClaw agents
- manages per-agent bridge lifecycle
- provides doctor/repair shell tooling
- ships doctrine/docs/examples

This is already part skill, part installer, part runtime manager.

## Assessment

### Keep as skill-only

**Pros**
- Minimal migration effort
- Matches current user mental model
- Already wired into existing install instructions

**Cons**
- Too much shell-script lifecycle logic
- Bridge/service management remains fragile
- Harder to expose first-class repair/doctor/add-agent behavior
- Identity/routing bugs are easier to create because lifecycle is indirect

### Migrate to native plugin

**Pros**
- Better fit for runtime/service/lifecycle control
- Can expose first-class install/doctor/repair/add-agent/remove-agent flows
- Cleaner ownership of config/state/service logic
- Easier to make Emperor bridge behavior a product surface instead of generated shell glue
- Can still ship skills alongside plugin runtime

**Cons**
- Requires packaging redesign
- More engineering upfront
- Need to validate ClawHub plugin publishing UX and install path carefully

## Recommendation

Best path: **hybrid migration**.

### Recommended split

#### Native plugin should own
- bridge runtime registration and lifecycle
- add-agent / repair / doctor / remove-agent flows
- direct-thread ownership/routing protections
- config + state manifest handling
- service management helpers

#### Skill content should own
- doctrine / operator instructions
- examples / references / templates
- human-facing docs and onboarding text

That keeps Emperor Claw OS consumer-facing content in `clawhub/*`, while moving operational machinery into a first-class OpenClaw extension model.

## Proposed migration phases

### Phase 1 — stabilize current skill package
- Keep `clawhub/emperor-claw-os` working for current users
- Ensure installer/runtime/docs stay fully inside `clawhub/*`
- Continue fixing multi-agent bridge behavior there

### Phase 2 — design native plugin package
Create an Emperor plugin with:
- `openclaw.plugin.json`
- runtime entrypoint
- install/doctor/repair/add-agent/remove-agent commands
- shipped skill directories for doctrine/content as needed

### Phase 3 — publish both temporarily
- Skill path remains supported for compatibility
- Plugin path becomes preferred for new installs
- Measure whether plugin path meaningfully simplifies support burden

### Phase 4 — converge
- If plugin path proves better, reduce the skill installer to a thin compatibility wrapper or deprecate it

## Immediate practical rule

Until migration is complete:
- Treat `clawhub/emperor-claw-os/*` as the canonical shipped package.
- Any consumer fix that is not reflected there is incomplete.
- SaaS-side repo code outside `clawhub/*` may support the product, but it is not enough for consumer install correctness.
