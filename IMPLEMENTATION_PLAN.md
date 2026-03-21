# Emperor Implementation Plan

This document turns the recent Mission Control comparison into an execution plan for Emperor Claw.

The goal is not to copy Mission Control wholesale.
The goal is to copy the parts that make it operationally reliable while preserving Emperor's stronger domain model:

- company -> customer -> project -> kanban
- durable memory
- incidents
- per-agent credentials and integrations
- direct human-to-agent control threads

## Working Principles

- Copy their discipline, not their entire product.
- Prefer one honest mechanism over multiple half-working surfaces.
- Put workflow and coordination rules in APIs and services, not only in UI or docs.
- Treat local OpenClaw bootstrap as part of the product.
- Avoid playbook-heavy magic when a simpler policy or template will do.

## What We Are Copying From Mission Control

### 1. Agent lifecycle convergence

Mission Control is stronger because it has an explicit wake -> check-in deadline -> retry -> offline loop.

Emperor should add:

- agent wake/check-in deadlines
- bounded wake retries
- explicit degraded/offline outcomes
- queue-backed reconciliation
- diagnostics for failed bootstrap, token drift, and missing heartbeat

### 2. Better agent-management boundaries

Mission Control keeps low-level gateway transport behind service boundaries.

Emperor should:

- centralize OpenClaw transport logic behind one runtime/cooperation service
- stop letting routes/components imply runtime behavior directly
- add architectural tests that prevent route-level transport drift

### 3. Simpler cooperation model

Mission Control's cooperation model is narrow and works:

- lead agent owns board coordination
- workers own execution
- approvals gate risky transitions
- board chat and notifications are operational signals, not fantasy autonomy

Emperor should adopt the same minimum model:

- one project lead role
- worker roles per project
- direct thread control for human -> lead
- explicit handoff notes for lead -> worker or worker -> lead
- approval/review only when policy requires it

### 4. Stronger kanban workflow

Mission Control's board works because statuses and review buckets are explicit.

Emperor should keep its project-based kanban but add:

- project-level workflow policies
- blocked/dependency visibility on every task card
- smarter review buckets
- approvals as first-class records

### 5. Local install/bootstrap

Mission Control treats setup as product, not documentation.

Emperor should ship a local companion that:

- installs bridge/runtime files near OpenClaw
- writes or updates required config
- aligns workspace and endpoint settings
- validates tokens and connectivity
- exposes doctor/sync/repair flows

## What We Are Not Copying

- the entire board-group/product taxonomy
- gateway-centric language as the main Emperor mental model
- a board-only product shape
- complexity that does not improve reliability
- rigid playbook doctrine as the main control surface

## Target Product Shape

Preserve this hierarchy:

- Company
- Customer
- Project
- Kanban
- Task

Operational mapping:

- company = tenant
- customer = portfolio/grouping surface
- project = workflow/board surface
- task = execution unit
- approval = governance record
- thread = communication primitive
- incident = failure/escalation record

## Simplified Agent Cooperation Model

This is the model Emperor should implement first.

### Roles

- `project_lead`
- `worker`
- `operator_human`

### Responsibilities

- Human operators communicate with the project lead through a direct thread.
- The project lead decides whether to act directly, delegate, or request approval.
- Workers claim eligible tasks and report status, notes, and results.
- Workers do not invent project scope or mutate workflow rules.
- Approval objects gate risky or sensitive transitions.

### Minimal cooperation primitives

- `task claim`
- `task note`
- `task handoff`
- `approval request`
- `approval resolve`
- `thread message`
- `incident update`
- `heartbeat`

That is enough to coordinate work without inventing a more complicated planning layer.

## Phased Plan

## Phase 1: Stabilize Runtime Integration

Objective: make Emperor + OpenClaw reliable before adding more product surface.

Deliverables:

- Build an Emperor local companion CLI/service.
- Replace the example-only bridge posture with a real local runtime adapter.
- Add agent lifecycle reconciliation with wake deadlines and bounded retries.
- Add doctor commands for token drift, WS reachability, heartbeat health, and thread/task flow.
- Keep the skill package as contract and docs, not the only installation story.

Likely files/modules:

- `clawhub/emperor-claw-os/examples/bridge.js`
- `clawhub/emperor-claw-os/SKILL.md`
- `src/app/api/mcp/agents/heartbeat/route.ts`
- `src/app/api/mcp/agents/[id]/sessions/start/route.ts`
- `src/lib/watchdog.ts`
- new runtime service under `src/lib/openclaw/`
- new local install/bootstrap tool under `scripts/` or a dedicated package

Success criteria:

- a fresh local install can connect, check in, renew leases, receive threads, and recover from temporary disconnects
- token drift and missing check-ins are diagnosable

## Phase 2: Canonical Messaging and Control

Objective: remove split-brain messaging.

Deliverables:

- Threads become the only canonical message primitive.
- Team feed becomes a derived visibility surface.
- Direct human-to-agent chat and team/project/task/incident threads share one backend model.
- Add delivery/execution states so operators can see if something was seen or acted on.

Likely files/modules:

- `src/lib/control-plane.ts`
- `src/app/api/chat/route.ts`
- `src/app/api/mcp/messages/send/route.ts`
- `src/app/api/mcp/threads/route.ts`
- `src/app/api/mcp/threads/[id]/messages/route.ts`
- `src/components/agent-team-chat.tsx`
- `src/components/agent-direct-chat.tsx`
- `src/components/openclaw-chat.tsx`

Success criteria:

- no separate legacy chat truth remains
- operator commands go through one consistent thread flow

## Phase 3: Upgrade Projects Into Real Workflow Surfaces

Objective: make project kanban behave like a real workflow engine.

Deliverables:

- Add project-level workflow policy flags:
  - `requireApprovalForDone`
  - `requireReviewBeforeDone`
  - `commentRequiredForReview`
  - `blockStatusChangesWithPendingApproval`
  - `onlyLeadCanChangeStatus`
  - `maxActiveAgents`
- Add first-class approvals and task links.
- Add review sub-buckets:
  - `approval_needed`
  - `waiting_review`
  - `blocked`
  - `ready_to_close`
- Improve task cards with blocked counts, dependency state, and review/approval state.

Likely files/modules:

- `src/db/schema.ts`
- `src/lib/task-state.ts`
- `src/app/api/mcp/tasks/route.ts`
- `src/app/api/mcp/tasks/claim/route.ts`
- `src/app/api/mcp/tasks/[id]/result/route.ts`
- `src/app/(app)/projects/projects-client.tsx`

Success criteria:

- kanban columns reflect enforceable workflow rules
- review and approval state are visible without opening each task

## Phase 4: Add Real Governance Without Overbuilding

Objective: copy the useful approval model, not the full complexity.

Deliverables:

- Add `approvals` table and task links.
- Add approve/reject endpoints and a company-level approvals view.
- Prevent invalid `done` or review transitions in API code.
- Restrict worker mutation scope to safe task fields.

Likely files/modules:

- `src/db/schema.ts`
- new routes under `src/app/api/approvals/`
- new MCP routes under `src/app/api/mcp/approvals/`
- `src/app/(app)/approvals/`

Success criteria:

- approval is a durable object with history
- risky transitions cannot bypass policy

## Phase 5: Portfolio and Customer Views

Objective: use Emperor's domain strengths instead of inventing new group abstractions.

Deliverables:

- customer portfolio snapshot view
- cross-project approval and blocked-task summaries
- top active tasks and incidents by customer
- customer-level memory/context surface

Likely files/modules:

- `src/app/(app)/customers/`
- `src/app/(app)/projects/`
- supporting snapshot services under `src/lib/`

Success criteria:

- customers act like the grouping/portfolio layer that Mission Control gets from board groups

## Phase 6: Remove Misleading Surfaces

Objective: stop shipping features that imply capabilities we do not actually have.

Deliverables:

- keep retired mission-planner/orchestrate flows dead
- remove or relabel any remaining fake-autonomy UI
- keep team feed clearly framed as transparency, not execution proof
- replace heavy playbook surfaces with lighter templates and project policies

Success criteria:

- the product says only what it truly does

## First Backlog To Execute

This is the recommended first implementation sequence.

1. Build local companion bootstrap and doctor.
2. Add lifecycle reconcile queue for agent check-in failures.
3. Unify message/thread flows and demote legacy team chat to derived view.
4. Add project workflow policy flags.
5. Add first-class approvals.
6. Rebuild project kanban review experience.

## Simplicity Rules

- No new planning/orchestration feature unless it closes a real reliability gap.
- No new chat surface unless it shares the same thread backend.
- No new agent role unless it has a clear API permission boundary.
- No new workflow status unless it changes behavior, not just presentation.
- No UI promise that the runtime cannot actually keep.

## Bottom Line

Emperor should become:

- easier to install locally
- stricter in runtime and workflow behavior
- simpler in operator mental model
- stronger at customer/project/kanban control-plane work

The winning move is not "be more magical than Mission Control."
It is "be more reliable than Mission Control while keeping a better business object model."
