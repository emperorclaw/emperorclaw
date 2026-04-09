# Contributing

## Scope

This package is the native OpenClaw plugin surface for Emperor-connected agents.

Keep these layers distinct:
- `src/`: plugin lifecycle, channel integration, manifests, bootstrap, repair, diagnostics
- `runtime/bridge.cjs`: standalone runtime bridge copied into companion directories
- `references/`: architecture and migration notes

## Rules

- Preserve the bridge contract in `references/BRIDGE-CONTRACT.md`.
- Do not break direct-thread binding, websocket plus sync fallback, scoped resource injection, or visible `@Agent Name` routing.
- Keep Emperor as the durable system of record. The bridge is transport/context glue, not the agent brain.
- Favor compatibility. Existing installed agents depend on `repair` being able to refresh their runtime safely.

## Before Opening A PR

Run:

```bash
npm run build
node --check runtime/bridge.cjs
```

If you changed bootstrap, bridge runtime, or doctrine behavior, also run:

```bash
scripts/validate-local.sh
```

## Release Notes

When changing public plugin behavior:
- bump `package.json` version
- keep `openclaw.plugin.json` version in sync
- publish a clear changelog entry
