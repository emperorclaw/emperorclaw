# Emperor Claw

A self-hostable control plane for AI agent workforces — durable state, coordination, and audit for teams of agents backed by OpenClaw or any MCP-compatible runtime.

**⚠️ Requires a single long-running process.** Emperor Claw uses WebSockets, a background watchdog, and a Postgres advisory lock for leader election. It does **not** run on serverless platforms (Vercel, Lambda, etc.). Deploy it on a VPS, a dedicated server, or a VM.

## Quick Start

### Docker (recommended)

```bash
cp .env.example .env
# Edit .env — set NEXTAUTH_SECRET and EMPEROR_CLAW_MASTER_KEY
docker compose up
```

Open `http://localhost:3000`.

### Manual

```bash
cp .env.example .env
npm install
npm run db:generate
npm run db:migrate
npm run dev
```

## What It Is

Emperor Claw is the **system of record** for agent workforces:

- **Agents** — Register, heartbeat, lease tasks
- **Projects & Tasks** — Kanban-style task tracking with lease-based execution
- **Incidents** — SLA breaches, dead letters, operator attention
- **Knowledge & Rules** — Reusable context (SOPs, templates, credentials, handbooks) scoped to company/customer/project/agent
- **Storage / Artifacts** — Durable files (reports, proofs, deliverables, invoices) with folder tree
- **Pipelines** — Agent-registered execution pipelines with auto-generated Mermaid diagrams
- **Chat & Threads** — Agent-to-agent and human-to-agent communication over WebSocket + Postgres LISTEN/NOTIFY

Emperor Claw is **not** the runtime that thinks or executes work — that's OpenClaw (or any MCP-compatible agent). Emperor is the durable control plane.

## Architecture

```
Emperor Claw (Next.js + custom server.ts)
  ├── WebSocket server (/api/mcp/ws) — realtime fanout
  ├── Postgres LISTEN/NOTIFY — cross-process events
  ├── Background watchdog — lease expiry, dead letters, incident creation
  └── Postgres advisory lock (20261010) — single-leader guard

Storage: local filesystem (default) or Bunny CDN (opt-in)
Auth: NextAuth v4 (Credentials + argon2) for UI, Bearer tokens for MCP API
```

## Storage Backends

| Backend | Config | Best For |
|---------|--------|----------|
| **local** (default) | `STORAGE_BACKEND=local` | Self-hosting, zero external deps |
| **bunny** | `STORAGE_BACKEND=bunny` + Bunny env vars | Production CDN-backed storage |

Local storage streams downloads through the authenticated app route — more secure than a public CDN URL, but not CDN-accelerated.

Want S3/MinIO/R2? See [CONTRIBUTING.md](./CONTRIBUTING.md) — it's a great first PR.

## Configuration

All configuration is via environment variables. See [`.env.example`](./.env.example) for the full reference with defaults and comments.

Required:
- `POSTGRES_CONNECTION_STRING`
- `NEXTAUTH_SECRET` (generate: `openssl rand -base64 32`)
- `EMPEROR_CLAW_MASTER_KEY` (generate: `openssl rand -hex 32`)

## OpenClaw Integration

Emperor Claw ships with a bridge runtime and plugin for OpenClaw agents. The bridge connects your local OpenClaw agents to the Emperor control plane, handles heartbeat, memory sync, and WebSocket events.

See [`clawhub/plugin/emperor-claw-os/`](./clawhub/plugin/emperor-claw-os/) for the integration package.

## Development

```bash
npm run dev     # Start dev server (custom server.ts + WebSocket)
npm run lint    # ESLint
npm test        # Architecture & smoke tests
npm run db:generate  # Generate Drizzle migrations
npm run db:migrate   # Apply migrations
```

## Docs

- [OPENCLAW_ALIGNMENT.md](./OPENCLAW_ALIGNMENT.md) — Architecture alignment with OpenClaw
- [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) — Roadmap
- [CONTRIBUTING.md](./CONTRIBUTING.md) — How to contribute

## License

MIT — see [LICENSE](./LICENSE).

Extra companion commands:

```bash
npm run control-plane:sync
npm run control-plane:repair
npm run control-plane:session-inspect
```
