# Pipelines Registry

A pipeline (shown as an **automation** in the app) is recurring or recursive work that an agent runs: a nightly lead-mining loop, a weekly report generator, or a monitor that fires on an event. The steps execute in the agent's runtime. Emperor is the registry that makes them visible, documented, and accountable, and it can start a run by handing the agent a task.

## The Agent-First Contract

The division of responsibility is strict:

| Concern | Owner |
|---|---|
| Building the pipeline, cron job, workflow, or loop | The agent, in its own runtime |
| Executing steps and handling errors | The agent runtime |
| Starting a run on schedule | The agent by default; Emperor when the automation is set to "Emperor runs it on schedule" (`scheduledBy: "emperor"`) |
| Starting a run on demand | A person (Run now), or an MCP client (`run_automation`) |
| Registering what exists and why | Emperor (`POST /pipelines`) |
| Documentation and visual map | Emperor Automations workspace |
| Run history, source usage, and evidence | Emperor (`POST /pipelines/{id}/runs`) |

Emperor never executes a pipeline's steps itself. When it starts a run (Run now, `run_automation`, or its own schedule), it records the run and creates a task for the runner agent with the steps and the run id; the agent does the work and reports back, and the run closes when the task is done or failed. Otherwise it records what agents declare and what they report. This follows the same doctrine as tasks: the durable write is the truth, and unregistered automation is invisible automation.

## Operator Workspace

The Automations page (`/pipelines`) shows who runs each automation and when, lets you run it now or pause it, and documents it.

- **Automations list**: search and filter by name, purpose, and status; each row shows the runner agent, the last run, the next run, Run now and an on/off switch.
- **How it runs**: the runner agent (changeable), the schedule in plain words with its time zone, the next run, who keeps the schedule (the agent or Emperor), and who created it.
- **Recent runs**: where each run came from (Run now and who pressed it, the agent, the schedule), how long it took, its summary, and links to its tasks.
- **Visual Map**: an automatic React Flow map of trigger -> Context Pack -> declared steps -> output -> run evidence.
- **Documentation**: the human-readable contract, context rules, workflow steps, recent runs, and copy-ready markdown.
- **Edit**: change when it runs and what it does (see [Editing An Automation In The App](#editing-an-automation-in-the-app)).
- **Delete**: removes the registry entry when a pipeline is obsolete. It does not delete external agent code.

Use the page to answer three operator questions quickly:

1. What does this automation do?
2. Which Company Brain context should ground it?
3. What evidence did the last runs produce?

## Editing An Automation In The App

A person who may change an automation (the same people who can pause it) and may hand work to its runner agent can open **Edit** on its detail; anyone else gets `403`, and nothing is changed or sent:

- **When it runs**: on a schedule or only when someone starts it. The schedule builder offers every hour, every day at a time, on chosen days at a time, or a custom cron. There is no "every N days" preset: cron's day-of-month step (`*/2`) restarts on the 1st of each month, so it can run on two days in a row (the 31st and the 1st). An existing cron like that opens as Custom with that warning; for a steady rhythm pick weekdays. Pick a time zone; the editor shows the schedule in plain words and its next three runs before you save. Emperor reads the same cron the same way. An automation that runs on an event keeps its trigger.
- **What it does**: purpose, documentation (Markdown), steps (add, remove, reorder, name, description, the agent of a step, and "Needs your approval" for a `gate`), and the Context Pack (query, tags, budget).
- The **name** is read-only: agents re-register by name, so a renamed automation would come back as a duplicate.

Only what changed is saved (`PATCH /api/pipelines/{id}` with `schedule: { cron, timezone }` or `null`, `purpose`, `docMarkdown`, `steps`, `contextQuery`, `contextResourceIds`, `contextTagFilters`, `contextMaxChars`; for the lists, `null` or `[]` clears them). The usual rules hold: an active automation keeps a purpose, documentation and at least one step (`422` with the reason), an unreadable cron or unknown time zone is refused (`400`), pinned sources must be this company's Company Brain resources (`400`), and Emperor's 15-minute minimum applies (`422`). The response's `agentNotified` says whether the runner agent was sent a message.

**A schedule saved in the app switches the automation to Emperor's schedule** (`scheduledBy: "emperor"`). Emperor computes the next run from the new schedule, starts each run and gives the runner agent a task; the agent's own schedule is no longer used. The editor says so before you save an automation the agent was scheduling.

**Handing the schedule back.** Choosing "The agent runs it from its runtime" again hands the schedule back: Emperor stops starting runs, the stored schedule stays as it is (it is not reverted to the agent's old one), the schedule is no longer operator-owned, and the runner agent gets a short message saying Emperor no longer starts it, with the stored cron and time zone to fire from its runtime.

**Edited fields are operator-owned.** The automation stores which fields a person edited (`operatorFields`: `schedule`, `purpose`, `docMarkdown`, `steps`, `context`), who edited it last and when; the detail shows them. When the agent registers the automation again (`POST /pipelines`) or updates it (`PATCH /pipelines/{id}`), Emperor keeps the person's values for those fields and applies the rest. The response carries `operatorOwned` (the operator-owned fields), `ignoredFields` (the ones the agent tried to change) and a warning telling the agent to read the automation and update its runtime to match. `list_automations` shows `operatorOwned` too.

**The agent is told.** After an edit, the runner agent gets one system message in its direct thread with what changed: the old and new schedule in plain words, or which parts were updated, and that Emperor now keeps the schedule. Saving the same values again changes nothing and sends nothing. Edits are in the Activity log (which fields, and the schedule; not the texts).

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
2. **Re-register on boot.** Registration is an upsert by `(company, name)`. Re-registering keeps `runtimeRef`, steps, and trigger accurate and never creates duplicates. Fields a person edited in the app stay as they set them; when the response lists `operatorOwned`, update your runtime to match instead.
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

The human operator can pause, activate, retire, or delete registry entries from the Automations page. A paused pipeline is an instruction to the agent: check the registry status before executing a cycle, and skip while paused. Emperor's own schedule never starts a paused automation, and it pauses one by itself (with the reason shown) after an invalid schedule or three failed starts in a row.

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

Base: `https://emperorclaw.example.com/api/mcp`

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
- If a person edited the automation in the app, the response adds `operatorOwned` and `ignoredFields`; those fields keep the person's values (see [Editing An Automation In The App](#editing-an-automation-in-the-app)).

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
