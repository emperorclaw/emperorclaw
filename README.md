# Emperor Claw

Emperor Claw is a multi-tenant control plane for OpenClaw-based agent workforces.

It is responsible for durable company state: agents, projects, tasks, incidents, credentials, chat threads, and audit history.
It is not the runtime that thinks or executes work. OpenClaw remains the runtime.

## Operating Model

- Emperor is the system of record.
- OpenClaw is the executor.
- WebSocket events are notification and coordination signals, not proof that work happened.
- Tasks are lease-based and must be renewed by heartbeat while work is in progress.
- Human-to-agent communication should flow through real threads, not fake orchestration helpers.

More detail is in [OPENCLAW_ALIGNMENT.md](./OPENCLAW_ALIGNMENT.md).

## What Changed Recently

- Removed the fake "mission for today" orchestration path from the active product flow.
- Hardened MCP auth and agent resolution so invalid agent ids do not silently create ghost agents.
- Added task lease renewal on heartbeat and watchdog fanout for retries, dead-lettering, and incident creation.
- Added a real incident resolution path for both UI and MCP.
- Tightened thread/message ownership checks so chat updates stay aligned with company scope.
- Reframed the skill package as an honest OpenClaw control-plane contract instead of a replacement runtime.

## Core Stack

- Next.js App Router
- PostgreSQL
- Drizzle ORM
- NextAuth
- WebSocket fanout over Postgres LISTEN/NOTIFY
- Background watchdog started from instrumentation

## Development

```bash
npm run dev
```

Open `http://localhost:3000`.

## Skill

The OpenClaw skill package lives in [clawhub/emperor-claw-os](./clawhub/emperor-claw-os).

Publish with:

```bash
npm run skill:publish
```
