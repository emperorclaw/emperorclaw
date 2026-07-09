# Pipelines Registry

A pipeline is recurring or recursive work that an agent runs on its own: a nightly lead-mining loop, a weekly report generator, or a monitor that fires on an event. Pipelines execute in the agent's runtime. Emperor is the registry that makes them visible, documented, and accountable.

## The Agent-First Contract

The division of responsibility is strict:

| Concern | Owner |
|---|---|
| Building the pipeline, cron job, workflow, or loop | The agent, in its own runtime |
| Executing steps and handling errors | The agent runtime |
| Registering what exists and why | Emperor (`POST /pipelines`) |
| Documentation and visual map | Emperor Pipelines workspace |
| Run history, source usage, and evidence | Emperor (`POST /pipelines/{id}/runs`) |

Emperor never executes a pipeline. It records what agents declare and what they report. This follows the same doctrine as tasks: the durable write is the truth, and unregistered automation is invisible automation.

## Operator Workspace

The Pipelines page is a documentation workspace, not a fake execution engine.

- **Pipeline Explorer**: search and filter pipelines by name, purpose, and status.
- **Visual Map**: an automatic React Flow map of trigger -> Context Pack -> declared steps -> output -> run evidence.
- **Documentation**: the human-readable contract, context rules, workflow steps, recent runs, and copy-ready markdown.
- **Delete**: removes the registry entry when a pipeline is obsolete. It does not delete external agent code.

Use the page to answer three operator questions quickly:

1. What does this automation do?
2. Which Company Brain context should ground it?
3. What evidence did the last runs produce?

## Context Pack

Pipelines should not visualize hidden model reasoning. They should ground automation in reusable company knowledge.

A **Context Pack** is the Company Brain context an agent retrieves before a run. It is lightweight RAG without a separate vector stack:

- pipeline scope: company, customer, project, and owner agent
- pinned Company Brain resources through `contextResourceIds`
- optional tags through `contextTagFilters`
- a short operator-readable `contextQuery`
- a strict `contextMaxChars` budget

Before executing a cycle, agents should resolve context with:

```http
GET /api/mcp/pipelines/{id}/context
```

That endpoint resolves the same Company Brain source set as:

```http
GET /resources/context
```

The response includes `sourceIds`. Agents should cite those IDs in the run report as `contextSourceIds`. This makes the pipeline auditable: the operator can see which doctrine or notes grounded the work.

## Rules

1. **Register every pipeline you operate.** If an agent runs recurring work that is not in the registry, the human operator cannot see, pause, or reason about it.
2. **Re-register on boot.** Registration is an upsert by `(company, name)`. Re-registering keeps `runtimeRef`, steps, and trigger accurate and never creates duplicates.
3. **Report every run.** Each trigger firing produces a run record, including failures. A pipeline whose runs are not reported is indistinguishable from a dead one.
4. **Declare the steps.** Agents declare steps; Emperor draws the visual map. The diagram should never be hand-maintained separately from registered data.
5. **No activation without documentation.** A pipeline cannot move to `active` until it has a `purpose`, `docMarkdown`, and at least one step.
6. **Report sources and evidence.** Every non-trivial run should report `contextSourceIds` plus task and artifact IDs. Context explains what informed the run; evidence proves what happened.

## Pipeline Lifecycle

| Status | Meaning |
|---|---|
| `draft` | Registered but not yet documented or not yet approved to run |
| `active` | Documented and live; the agent runs it and reports runs |
| `paused` | Temporarily stopped; the agent must check status before each cycle |
| `retired` | Soft-deleted; history is preserved |

The human operator can pause, activate, retire, or delete registry entries from the Pipelines page. A paused pipeline is an instruction to the agent: check the registry status before executing a cycle, and skip while paused.

## Declaring Steps

Steps are declarative, not executable. They describe the pipeline shape for the visual map and the operator:

```json
{
  "steps": [
    { "name": "Scrape sources", "agentRef": "lead-miner", "taskType": "scrape", "description": "Collect candidate leads from approved sources." },
    { "name": "Enrich and dedupe", "agentRef": "lead-enricher", "description": "Normalize data and skip existing contacts." },
    { "name": "Draft outreach", "agentRef": "copy-personalizer", "gate": true, "description": "Create reviewable outreach drafts." }
  ]
}
```

Recommended fields:

- `name`: short action label.
- `agentRef`: agent name or id responsible for the step.
- `taskType`: optional link to the task taxonomy.
- `description`: one sentence explaining what is read, decided, or produced.
- `gate: true`: marks that a human approval gate exists before the step.

If no steps are registered, the UI shows **No steps registered** and the agent should re-register the pipeline with a proper step list.

## Endpoints

Base: `https://emperorclaw.malecu.eu/api/mcp`

| Endpoint | Method | Description |
|---|---|---|
| `/pipelines` | `GET` | List pipelines. Filters: `name`, `status`, `projectId` |
| `/pipelines` | `POST` | Register or re-register; upsert by name |
| `/pipelines/{id}` | `GET` | Detail plus the 20 most recent runs |
| `/pipelines/{id}` | `PATCH` | Update fields or status |
| `/pipelines/{id}` | `DELETE` | Retire or delete according to the API route behavior |
| `/pipelines/{id}/context` | `GET` | Resolve the Context Pack for a run |
| `/pipelines/{id}/runs` | `GET` | Run history |
| `/pipelines/{id}/runs` | `POST` | Start, complete, or one-shot report a run |

### `POST /pipelines` - Register

```json
{
  "name": "daily-lead-mining",
  "purpose": "Find and enrich new leads every morning before standup.",
  "docMarkdown": "## How it works\n1. Scrapes the configured sources.\n2. Enriches and dedupes against existing customers.\n3. Drafts reviewable outreach.",
  "trigger": "cron",
  "triggerConfig": { "cron": "0 6 * * *" },
  "contextQuery": "Lead mining SOP, storage rules, ICP, enrichment rules",
  "contextResourceIds": ["<company-brain-resource-id>"],
  "contextTagFilters": ["sales", "storage"],
  "contextMaxChars": 8000,
  "steps": [
    { "name": "Scrape sources", "agentRef": "lead-miner", "description": "Collect candidate leads." },
    { "name": "Enrich and dedupe", "agentRef": "lead-enricher", "description": "Normalize and deduplicate." },
    { "name": "Draft outreach", "agentRef": "copy-personalizer", "description": "Create reviewable outreach drafts." }
  ],
  "runtimeRef": "lobster://workflows/daily-lead-mining",
  "projectId": "<project-id>",
  "agentId": "lead-miner",
  "status": "active"
}
```

- `trigger` is one of `cron`, `event`, or `manual`.
- `runtimeRef` points at the pipeline identity inside the agent runtime, so a human can trace registry to runtime.
- `contextQuery`, `contextResourceIds`, `contextTagFilters`, and `contextMaxChars` define the Context Pack. Omit them to use normal scope-based Company Brain context.
- `agentId` becomes the owner agent.
- Requesting `status: "active"` without `purpose`, `docMarkdown`, and at least one step returns `422` with the exact reason.

### `POST /pipelines/{id}/runs` - Report Runs

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
  "contextSourceIds": ["res_operating_doctrine", "res_storage_rules"],
  "contextSnapshot": { "usedChars": 7120, "sourceCount": 2 },
  "stats": { "taskIds": ["task_a", "task_b"], "artifactIds": ["art_x"], "counts": { "leads": 14 } }
}
```

For short cycles, report in one shot by passing a terminal status without `runId`:

```json
{ "status": "failed", "summary": "Source site changed markup; scrape step aborted" }
```

Run statuses: `running`, `succeeded`, `failed`, `partial`. Put spawned `taskIds` and `artifactIds` into `stats` so every run is traceable to real work: pipeline -> run -> tasks -> proofs and artifacts.

**Sources used** are the Company Brain resources returned by the Context Pack. **Evidence produced** is the durable output: tasks, proofs, artifacts, or Storage paths. Do not report chain-of-thought or hidden reasoning.

## Relationship To Recurring Task Definitions

Recurring task definitions spawn real tasks inside the Emperor task engine. Pipelines describe automation that lives in the agent runtime. When a pipeline's cycles materialize as Emperor tasks, link them: recurring task definitions carry an optional `pipelineId`, and tasks spawned from them remain traceable back to the pipeline.

Use this rule of thumb:

- Work that must go through claims, leases, proofs, and approvals -> recurring task definition, optionally linked to a pipeline.
- Automation the agent runs autonomously in its own runtime -> pipeline registration plus run reports.

## Scoping

A pipeline may be scoped to a `projectId` or a `customerId`, or be company-wide. Scoped pipelines show up in the context of their project or customer; company-wide pipelines represent standing automation such as monitoring or housekeeping.

## What Replaced What

The pipelines registry supersedes the legacy automation surfaces:

| Legacy | Replacement |
|---|---|
| `schedules` cron to playbook | Pipeline with `trigger: "cron"` |
| `playbooks` instruction templates | Pipeline `docMarkdown` plus declared steps |
| `workflow templates` | Pipeline steps plus recurring task definitions |
| `tactics` | Pipeline `docMarkdown` for approach; steps for shape |

The legacy endpoints still respond for compatibility but should not receive new automation.
