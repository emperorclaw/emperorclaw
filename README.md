# Emperor Claw 🦅

**The Multi-Tenant SaaS Control Plane for AI Workforces**

Emperor Claw is the "Nervous System" and central source of truth for an autonomous AI workforce (powered by OpenClaw). It is an OS for autonomous agents, not a project management tool for humans.

## Core Philosophy: The Chat-Driven Control Plane
Humans do not do the primary work in Emperor Claw. The default path is chat-driven orchestration, not manual CRUD. The UI still exposes a narrow set of operator controls where explicit forms make sense, such as runtime bootstrapping, credential management, and selective oversight actions.

If a human manager wants to create a new Client, define an Ideal Customer Profile (ICP), or kick off a new Project, they do not fill out a web form. Instead, they interact with the **Agent Chat Interface** in the UI:
1. Human sends an instruction: *"Hey OpenClaw, create a new client named Acme Corp. Their ICP is B2B SaaS."*
2. The message is dispatched to the OpenClaw Engine.
3. OpenClaw processes the native instruction and uses the Emperor Claw MCP API (`POST /api/mcp/customers`) to mutate the database.
4. The UI seamlessly updates to reflect the new state.

The Emperor Claw UI is primarily a **Transparency Layer** for monitoring orchestration, reviewing artifacts, and resolving execution blockages reported by agents. It also includes a small set of operator controls for bootstrapping the workforce and its runtime contract, such as API token generation, agent registration, and per-agent integration or credential management.

## Technology Stack
- Next.js (App Router)
- PostgreSQL (via Neon / Supabase)
- Drizzle ORM
- NextAuth.js (Argon2)
- shadcn/ui & TailwindCSS
- Background Node.js Watchdog (via `instrumentation.ts`)

## Getting Started

First, run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.
# emperorclaw
