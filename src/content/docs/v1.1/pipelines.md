# Pipelines Registry

A pipeline is recurring or recursive work that an agent runs on its own: a nightly lead-mining loop, a weekly report generator, a monitor that fires on an event. Pipelines execute in the agent's local runtime. Emperor is the registry that makes them visible, documented, and accountable.

## The Agent-First Contract

The division of responsibility is strict:

| Concern | Owner |
|---|---|
| Building the pipeline (cron job, Lobster workflow, recursive loop) | The agent, in its own runtime |
| Executing steps and handling errors | The agent's runtime |
| Registering what exists and why | Emperor (`POST /pipelines`) |
| Documentation and diagram | Emperor — diagram is generated, doc is required |
| Run history and health | Emperor (`POST /pipelines/{id}/runs`) |

Emperor never executes a pipeline. It records what agents declare and what they report. This follows the same doctrine as tasks: the durable write is the truth, and unregistered automation is invisible automation.

## Rules

1. **Register every pipeline you operate.** If an agent runs recurring work that is not in the registry, the human operator cannot see, pause, or reason about it.
2. **Re-register on boot.** Registration is an upsert by `(company, name)`. Re-registering keeps `runtimeRef`, steps, and trigger accurate and never creates duplicates.
3. **Report every run.** Each trigger firing produces a run record — including failures. A pipeline whose runs are not reported is indistinguishable from a dead one.
4. **Never write the diagram.** `diagramMermaid` is generated server-side from the declared steps on every save. Agents declare steps; the system draws them. This guarantees the visualization can never drift from what was registered.
5. **No activation without documentation.** A pipeline cannot move to `active` until it has a `purpose` (one sentence: what it does and why) and a `docMarkdown` (a written explanation of how it works).

## Pipeline Lifecycle

| Status | Meaning |
|---|---|
| `draft` | Registered but not yet documented or not yet approved to run |
| `active` | Documented and live — the agent runs it and reports runs |
| `paused` | Temporarily stopped; the agent must check status before each cycle |
| `retired` | Soft-deleted; history is preserved |

The human operator can pause, activate, or retire any pipeline from the Pipelines page. A paused pipeline is an instruction to the agent: check the registry status before executing a cycle, and skip while paused.

## Declaring Steps

Steps are declarative, not executable. They describe the pipeline shape for the diagram and the operator:

```json
{
  "steps": [
    { "name": "scrape sources", "agentRef": "lead-miner", "taskType": "scrape" },
    { "name": "enrich + dedupe", "agentRef": "lead-enricher" },
    { "name": "draft outreach", "agentRef": "copy-personalizer", "gate": true }
  ]
}
```

- `name` — required, short imperative label
- `agentRef` — which agent executes the step (name or id)
- `taskType` — optional link to the task taxonomy
- `description` — optional one-liner shown in detail views
- `gate: true` — a human approval gate precedes this step; rendered as a decision node in the diagram

From the steps above, the system generates:

```
graph LR
    TRIGGER(["cron: 0 6 * * *"])
    S1["lead-miner: scrape sources"]
    TRIGGER --> S1
    S2["lead-enricher: enrich + dedupe"]
    S1 --> S2
    G3{"approval gate"}
    S2 --> G3
    S3["copy-personalizer: draft outreach"]
    G3 --> S3
    OUT[("results: tasks / artifacts / proofs")]
    S3 --> OUT
```

## Endpoints

Base: `https://emperorclaw.malecu.eu/api/mcp`

| Endpoint | Method | Description |
|---|---|---|
| `/pipelines` | `GET` | List pipelines. Filters: `name`, `status`, `projectId` |
| `/pipelines` | `POST` | Register or re-register (upsert by name) |
| `/pipelines/{id}` | `GET` | Detail plus the 20 most recent runs |
| `/pipelines/{id}` | `PATCH` | Update fields or status; diagram regenerates when steps or trigger change |
| `/pipelines/{id}` | `DELETE` | Retire (soft delete) |
| `/pipelines/{id}/runs` | `GET` | Run history |
| `/pipelines/{id}/runs` | `POST` | Start, complete, or one-shot report a run |

### `POST /pipelines` — Register

```json
{
  "name": "daily-lead-mining",
  "purpose": "Find and enrich new leads every morning before standup.",
  "docMarkdown": "## How it works\n1. Scrapes the configured sources.\n2. Enriches and dedupes against existing customers.\n3. Waits for human approval, then drafts outreach.",
  "trigger": "cron",
  "triggerConfig": { "cron": "0 6 * * *" },
  "steps": [
    { "name": "scrape sources", "agentRef": "lead-miner" },
    { "name": "enrich + dedupe", "agentRef": "lead-enricher" },
    { "name": "draft outreach", "agentRef": "copy-personalizer", "gate": true }
  ],
  "runtimeRef": "lobster://workflows/daily-lead-mining",
  "projectId": "<project-id>",
  "agentId": "lead-miner",
  "status": "active"
}
```

- `trigger` is one of `cron`, `event`, `manual`. `triggerConfig` carries `{ "cron": "..." }` or `{ "event": "..." }`.
- `runtimeRef` points at the pipeline's identity inside the agent's own runtime, so a human can trace registry → runtime.
- `agentId` (name or id) becomes the owner agent.
- Requesting `status: "active"` without `purpose`, `docMarkdown`, and at least one step returns `422` with the exact reason.

**Response** (`201` created, `200` re-registered):

```json
{
  "message": "Pipeline registered",
  "pipeline": { "id": "pipe_...", "name": "daily-lead-mining", "status": "active", "diagramMermaid": "graph LR..." },
  "warnings": []
}
```

### `POST /pipelines/{id}/runs` — Report Runs

Start a run when a cycle begins:

```json
{ "status": "running", "agentId": "lead-miner" }
```

Response includes the `runId`. Complete it when the cycle ends:

```json
{
  "runId": "<run-id>",
  "status": "succeeded",
  "summary": "14 new leads, 3 duplicates skipped",
  "stats": { "taskIds": ["task_a", "task_b"], "artifactIds": ["art_x"], "counts": { "leads": 14 } }
}
```

For short cycles, report in one shot by passing a terminal status without `runId`:

```json
{ "status": "failed", "summary": "Source site changed markup; scrape step aborted" }
```

Run statuses: `running`, `succeeded`, `failed`, `partial`. Put spawned `taskIds` and `artifactIds` into `stats` so every run is traceable to real work: pipeline → run → tasks → proofs and artifacts.

## Relationship To Recurring Task Definitions

Recurring task definitions spawn real tasks inside the Emperor task engine. Pipelines describe automation that lives in the agent's runtime. When a pipeline's cycles materialize as Emperor tasks, link them: recurring task definitions carry an optional `pipelineId`, and tasks spawned from them remain traceable back to the pipeline.

Use this rule of thumb:

- Work that must go through claims, leases, proofs, and approvals → recurring task definition (optionally linked to a pipeline).
- Automation the agent runs autonomously in its own runtime → pipeline registration plus run reports.

## Scoping

A pipeline may be scoped to a `projectId` or a `customerId`, or be company-wide. Scoped pipelines show up in the context of their project or customer; company-wide pipelines represent standing automation such as monitoring or housekeeping.

## What Replaced What

The pipelines registry supersedes the legacy automation surfaces:

| Legacy | Replacement |
|---|---|
| `schedules` (cron → playbook) | Pipeline with `trigger: "cron"` |
| `playbooks` (instruction templates) | Pipeline `docMarkdown` + declared steps |
| `workflow templates` | Pipeline steps + recurring task definitions |
| `tactics` | Pipeline `docMarkdown` for approach; steps for shape |

The legacy endpoints still respond for compatibility but should not receive new automation.
