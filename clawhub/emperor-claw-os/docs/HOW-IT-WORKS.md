# How Emperor Claw OS Works

A technical overview of the SaaS Control Plane architecture.

## System Architecture

```ascii
┌─────────────────────────────────────────────────────────────────────┐
│                       Emperor Claw (SaaS)                           │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐  │
│  │     Web UI      │───▶│   PostgreSQL    │    │      MCP API    │  │
│  │   (Next.js)     │    │   (Database)    │    │ (api/mcp/...)   │  │
│  └────────┬────────┘    └─────────────────┘    └────────┬────────┘  │
└───────────┼────────────────────────────────────────────┼────────────┘
            │                                             │
            │ Direct User Actions                         │ HTTP REST + Polling
            │                                             ▼
┌───────────┼─────────────────────────────────────────────────────────┐
│           │            OpenClaw Environment                         │
│           │                                                         │
│           │             ┌─────────────────┐                         │
│           │             │   Viktor        │                         │
│           │             │  (Manager)      │                         │
│  ┌────────┴────────┐    └────────┬────────┘                         │
│  │   Human User    │             │ Delegates Tasks                  │
│  │  (reads UI,     │             ▼                                  │
│  │   adds Goals)   │    ┌─────────────────┐                         │
│  └─────────────────┘    │ Worker Agents   │                         │
│                         │ (Specialists    │                         │
│                         │  or Fallbacks)  │                         │
│                         └─────────────────┘                         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Component Details

### 1. Emperor Claw (The SaaS Control Plane)

The source of truth. Hosted at [emperorclaw.malecu.eu](https://emperorclaw.malecu.eu).
Humans use the web interface to define Customers, high-level Goals, establish Templates, and visualize the Kanban board.

### 2. The MCP API

Unlike legacy hook-based systems, Emperor Claw does not send outbound webhooks to your local machine (requiring insecure tunnels like ngrok/Tailscale).

Instead, it offers a secure, authenticated REST API under `/api/mcp/*`. All state changes—claiming tasks, registering agents, updating memories—are push-mutations from OpenClaw via idempotent `POST` and `PATCH` requests.

### 3. OpenClaw (The Runtime)

Your local machine (or hosted server) running the actual LLMs and execution code.

When OpenClaw boots up, it reads config and begins operation. The Manager (`Viktor`) queries Emperor Claw for pending work, spins up sub-agents, and manages execution using the rules defined in `SKILL.md`.

---

## Data Flow: Task Lifecycle

The fundamental loop of Emperor Claw OS relies on State Machines, not diff transforms.

### The Polling Loop (Long Polling)
1. **Manager Agent** calls `GET /api/mcp/messages/sync` using long polling.
2. If the Human User issues a command via UI chat, the connection resolves immediately returning the message.
3. If no messages arrive after 25s, it responds empty, and the Manager immediately reconnects.

### The Execution Loop
1. **Manager** identifies a goal and breaks it down into Tasks.
2. **Manager** calls `POST /api/mcp/tasks` setting the items to `state: "queued"`.
3. **Worker Agent** queries the API for queued work matching its skills.
4. **Worker Agent** calls `POST /api/mcp/tasks/claim`. The server atomically transitions the task to `state: "running"`. If two workers try to claim simultaneously, one gets a 409 Conflict.
5. **Worker** performs the job natively.
6. **Worker** calls `POST /api/mcp/tasks/{id}/result` with `state: "done"`.

---

## Security Considerations

1. **API Tokens** — Randomly generated per workspace inside the SaaS. Stored securely.
2. **No Inbound Firewalls to Pierce** — Because everything is outbound REST or Long Polling, your local environment remains perfectly locked down behind your NAT/Firewall.
3. **Idempotency Keys** — All state-changing endpoints require an `Idempotency-Key` header (UUIDv4). If a worker's connection drops during a completion request, retrying the exact request guarantees the operation only happens once.
