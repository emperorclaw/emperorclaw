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

## Human And Agent Assignment

A task has one current assignee: one company member, one agent, or nobody.
Assignment and state are independent, so assigning a task does not
automatically start it. An agent only receives a lease when it claims or starts
the task.

Reassignment is the basic handoff between the human and AI workforce. Assigning
active agent work to a human or a different agent revokes the previous lease so
the old runtime cannot continue completing the task.

Agent claim rules respect existing ownership:

- unassigned inbox work may be claimed by any eligible agent
- agent-assigned inbox work may only be claimed by that agent
- an in-progress task handed to an agent can be claimed when no lease is active
- human-assigned work cannot be claimed by an agent

Existing integrations that use `assignedAgentId` remain supported. New
integrations should use the unified `assignee` object documented in the API
reference.

## Member Access Scoping

Admins can restrict what individual team members can see via Settings → Members → Shield icon:

| Scope mode | Effect |
|------------|--------|
| All access (default) | Member sees everything in the company |
| Restricted access | Member only sees selected agents, customers, and their associated data |

When restricted:
- **Agents page**: only selected agents appear
- **Customers page**: only the customers they have access to appear
- **Knowledge Base**: resources scoped to visible agents/customers/projects
- **Storage**: artifacts linked to visible customers and projects
- **Projects**: projects of their customers, plus projects shared with them directly
- **Dashboard KPIs**: counts reflect only visible data

The agent list lives on the member; the customers and projects come from
**Access** (below). Both are read from the database on every request, so a
change applies on the next page load.

## Access To Clients And Projects

Every client and project page has an **Access** button. It lists who has a
role there and lets its admins add a person (an existing member, or an email
invitation) as **Admin**, **Can edit** or **Can view**.

- Inside that client or project a person acts with the higher of their company
  role and their role there. A company viewer with **Can edit** on Harbor
  Dental edits Harbor Dental's tasks, notes, views and files, and nothing else.
- A client's role covers all its projects.
- A restricted member sees only the clients and projects they have access to.
  Inviting someone from the Access dialog makes them exactly that: they see
  only that client or project.
- Admins of a client or project manage its Access but can never grant more
  than their own role, and never change company roles, billing, modules,
  settings, agents or tokens.
- Settings → Members shows each person's custom access ("Harbor Dental · Can
  edit"). Every change is in the Activity log.

Nothing changes for a company that never opens Access.

## Who Can Use An Agent

The hire dialog and the agent's Scope tab have one setting, **Who can use it**:

| Setting | Who can chat with it, mention it, give it work |
|---------|------------------------------------------------|
| Everyone (default) | Every member whose access includes the agent |
| Specific people | Its owner and the people picked |
| Only one person | Its owner |

Owners and admins who are not on the list see a locked card: name, owner,
status and cost, never its chats. They can change who can use it, hand it to
someone else (both owners are notified) or delete it, but cannot add
themselves. If the owner leaves the company, an admin can recover the agent
(new owner, everyone, or themselves); its earlier chats stay archived. An
agent only its owner can use never sees more data than its owner. Agents and
their bridges keep working as before.

"Who can use it" protects an agent from other members. It is not a guarantee
against an admin: admins can mint company-wide MCP tokens, and such a token
can act as any agent, including reading that agent's direct and private
chats, the way its bridge does. Fleet bridges depend on this, so it is the
trust model: give token rights only to people you would trust with every
agent's conversations.

Recovering an orphaned agent archives its shared chat and hides it, and the
runs that answered it, from everyone. The agent's own memory stays with the
agent: what it learned in those chats can still shape its answers to its new
owner.

Inside a client or project, a restricted member's role there is exactly the
role they were given: **Can view** is read-only, whatever their company role.

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
