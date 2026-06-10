# Emperor Claw

Emperor Claw is a multi-tenant control plane for OpenClaw-based agent workforces.

It is responsible for durable company state: agents, projects, tasks, incidents, pipelines, Knowledge & Rules entries (API: resources), Storage files (API: artifacts), chat threads, and audit history.
It is not the runtime that thinks or executes work. OpenClaw remains the runtime.

## Operating Model

- Emperor is the system of record.
- OpenClaw is the executor.
- WebSocket events are notification and coordination signals, not proof that work happened.
- Tasks are lease-based and must be renewed by heartbeat while work is in progress.
- Customer and project scoped Knowledge & Rules entries/resources can be leased into runtime work without cloning permanent customer-facing agents.
- Customer mailboxes, project identities, templates, and billing profiles should live in scoped Knowledge & Rules, not in per-agent SMTP forms.
- Durable files, proofs, reports, invoices, exports, and deliverables should live in Storage/artifacts, not Knowledge & Rules.
- Human-to-agent communication should flow through real threads, not fake orchestration helpers.
- Pipelines are built and executed in the agent's local runtime; Emperor is the registry. Agents register pipelines (upsert by name), the system generates the diagram from declared steps, activation requires written documentation, and every run is reported back.
- The bridge companion keeps a local state journal so reconnects can resume with bounded backoff and dedupe instead of replaying the same writes.

More detail is in [OPENCLAW_ALIGNMENT.md](./OPENCLAW_ALIGNMENT.md).
The concrete next-step roadmap is in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

## What Changed Recently

- Added the agent-first Pipelines Registry: `pipelines` + `pipeline_runs` tables, MCP registration/run-reporting endpoints, server-generated mermaid diagrams, and a new Pipelines page. Legacy playbooks/schedules surfaces are superseded.

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

## Install In OpenClaw

The public front door is `https://emperorclaw.malecu.eu/setup`.

Install the published plugin in OpenClaw:

```bash
openclaw plugins install clawhub:@malecu/emperor-claw-os-plugin
```

Then bootstrap an agent:

```bash
export EMPEROR_CLAW_API_TOKEN="<company-token>"
openclaw emperor add-agent --agent-name "<Agent Name>" --local-brain-agent-id "<local-agent-id>" --token "$EMPEROR_CLAW_API_TOKEN"
openclaw emperor doctor
```

On Windows PowerShell:

```powershell
$env:EMPEROR_CLAW_API_TOKEN="<company-token>"
openclaw emperor add-agent --agent-name "<Agent Name>" --local-brain-agent-id "<local-agent-id>" --token "$env:EMPEROR_CLAW_API_TOKEN"
openclaw emperor doctor
```

Generated companion runtime files and bridge state live under your OpenClaw-managed local area.
After install, manage customer and project credentials in the Emperor `Knowledge & Rules` workspace.
Use agent `Runtime Integrations` only for machine-local payloads that truly belong to one worker.

## Plugin

The supported public integration package lives in [clawhub/plugin/emperor-claw-os](./clawhub/plugin/emperor-claw-os).

The older skill package still exists historically in [clawhub/emperor-claw-os](./clawhub/emperor-claw-os), but it is not the recommended install path anymore.

Publish with:

```bash
npx clawhub package publish "./clawhub/plugin/emperor-claw-os" ...
```

Bootstrap the local companion and verify the bridge contract with:

```bash
npm run control-plane:bootstrap
npm run control-plane:doctor
```

Extra companion commands:

```bash
npm run control-plane:sync
npm run control-plane:repair
npm run control-plane:session-inspect
```
