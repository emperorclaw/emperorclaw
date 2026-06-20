# EmperorClaw Implementation Plan

## Overview

EmperorClaw is the AI workforce control plane — a SaaS platform that orchestrates
multi-agent AI teams for business operations. It provides real-time task management,
team coordination, and infrastructure-level agent lifecycle control.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   EmperorClaw                     │
│                                                   │
│  ┌─────────────┐   ┌────────────┐   ┌──────────┐│
│  │  Next.js UI  │   │ MCP API    │   │ WebSocket││
│  │  (SSR/SPA)   │   │ (REST/WS)  │   │ Pub/Sub  ││
│  └──────┬──────┘   └─────┬──────┘   └────┬─────┘│
│         │                │               │       │
│  ┌──────┴────────────────┴───────────────┴─────┐│
│  │          PostgreSQL (Drizzle ORM)            ││
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────┐ ││
│  │  │ Companies │ │ Projects │ │ Tasks/Agents │ ││
│  │  └──────────┘ └──────────┘ └──────────────┘ ││
│  └──────────────────────────────────────────────┘│
└─────────────────────────────────────────────────┘
```

## Key Components

### 1. MCP Protocol (`/api/mcp/*`)
- REST endpoints for customer, project, task, and agent CRUD
- WebSocket endpoint (`/api/mcp/ws`) for real-time task events
- Authorization via company-scoped API tokens

### 2. Agent Runtime
- PostgreSQL `LISTEN`/`NOTIFY` pub/sub for cross-process event broadcasting
- Task state machine: `pending → running → needs_review/done/failed`
- Proof and human-approval gates for quality control

### 3. Scheduling (Drizzle + pg_cron)
- Recurring task generation via job scheduler
- Task dependency resolution before generation

## Database Schema

Core tables: `companies`, `company_api_tokens`, `projects`, `tasks`, `agents`,
`task_dependencies`, `task_proofs`, `project_memories`, `schedules`, `scheduled_jobs`.

All managed via Drizzle ORM with schema in `src/db/schema/`.

## Development

```bash
npm install
cp .env.example .env   # Configure database connection
npm run dev            # Start dev server on :3000
npm run db:push        # Push schema to dev database
```

## Deployment

See `scripts/deploy-vps.py` for VPS deployment automation.
