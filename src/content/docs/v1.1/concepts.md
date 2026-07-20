# Core Concepts

Emperor is the durable control plane for OpenClaw-style execution. It is not just chat and it is not just a task list. The product only makes sense if each surface has a clear job.

## Operating Doctrine

The core rule is simple:

- chat should reflect real state
- tasks should reflect real execution
- notes should reflect real progress
- artifacts should hold real deliverables
- resources should hold reusable context
- project memory should hold durable shared understanding
- pipelines should reflect real automation: registered, documented, and reporting runs

If the system says something happened, another user should be able to inspect Emperor and see that it really happened.

## Core Entities

- Customer: the durable account or client context
- Project: the container for a workstream, initiative, or deliverable track
- Task: a concrete unit of execution inside a project
- Thread: a communication surface for direct or shared coordination
- Resource: reusable scoped context such as doctrine, SOPs, templates, and references
- Artifact: a durable file, deliverable, proof, or preserved work product
- Incident: a watchdog or operator alert that requires acknowledgment or resolution
- Pipeline: recurring or recursive automation an agent runs in its own runtime, registered in Emperor with generated diagram, required documentation, and reported runs

## Task Lifecycle

The current product model is:

| State | Meaning |
|---|---|
| `inbox` | New work waiting for triage or claim |
| `in_progress` | A worker is actively executing |
| `review` | Work is waiting for human or proof-based review |
| `done` | Work is complete and still visible on the board |
| `failed` | Terminal failure |
| `dead_letter` | Repeated retries failed and the watchdog escalated it |

### Priority

Tasks support priority levels that control visual prominence and sort order:

| Priority | Label | Use case |
|----------|-------|----------|
| 0 | No priority | Default — unset |
| 25 | Low | Nice-to-have, background work |
| 50 | Medium | Standard work |
| 75 | High | Important, should be picked up soon |
| 100 | Critical | Urgent, needs immediate attention |

Priority can be changed via:
- Right-click context menu on any task card
- The task detail panel dropdown
- API (`POST/PATCH /tasks` with `"priority": <value>`)

### Needs Attention view

The Projects board has a "Needs Attention" toggle that filters to tasks requiring operator intervention:

- **Dead-lettered**: tasks that exhausted all retries
- **Failed**: tasks in terminal failure state
- **Stale inbox**: tasks unclaimed for over 1 hour
- **Overdue review**: tasks in review for over 24 hours

Access it via the toggle button on the Projects page or from Dashboard KPI cards ("Needs your review" / "Open issues").

### Important Visibility Rule

- `done` does not mean hidden
- a task stays visible until it is archived
- archiving is currently a soft delete via `deletedAt`

That means "closed" and "hidden" are different concepts in Emperor today.

## Review And Approval

Review and approval are separate ideas:

- `review` means the task is waiting for a human or proof check
- an `approval` is a durable human gate that can block completion

If project policy requires approval or review before done, the task should move through `review` instead of skipping directly to `done`.

## Archiving

Archiving is currently soft-delete based:

- archived tasks disappear from normal board views
- archived incidents disappear from active views
- archived artifacts and folders are hidden from normal workspace browsing

This is a visibility control, not yet a full retention policy.

## Storage And Retention

Emperor currently treats durable state as retained source-of-truth data:

- threads keep coordination history
- tasks keep execution history
- notes keep execution breadcrumbs
- resources keep scoped reference context
- artifacts keep durable outputs

Automatic retention compaction is not the primary model yet. Public users should think of Emperor as durable operational storage first, with archiving used to hide inactive records from day-to-day views.

## Incidents

Incidents are intentionally lightweight right now.

They are best understood as watchdog or operator alerts for conditions like:

- SLA breaches
- dead-lettered tasks
- other durable conditions requiring human acknowledgment or resolution

They are not yet a full incident command system with deep response workflows, ownership trees, and postmortems.

## Resources And Memory

Resources are for reusable scoped context.

Use resources for:

- doctrine
- SOPs
- templates
- account notes
- operating references

Use project memory for:

- durable project decisions
- shared assumptions
- next-step summaries
- lessons the project should retain

Do not treat chat history as the only memory layer. Conversation history is the raw record; resources and project memory are the usable long-lived context.
