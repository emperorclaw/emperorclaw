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

## Current Status

Completed:

- Local companion bootstrap and doctor exist under `scripts/control-plane.js`.
- Server-side lifecycle monitor exists and runs separately from the task watchdog.
- Project workflow policy fields exist in schema and MCP project APIs.
- Durable approvals exist with web and MCP routes plus an approvals workspace.
- Projects board UI now uses `inbox`, `in_progress`, `review`, `done`, plus a recurrent lane.
- Review buckets are visible in the projects UI.
- Customers now act as a portfolio grouping layer with summaries.
- Team and direct chat surfaces now bootstrap from canonical thread data instead of legacy-only chat reads.

Partially completed:

- Canonical messaging is mostly in place, but legacy `chat_messages` mirroring still exists for compatibility and inbound webhook flow.
- Cooperation rules are enforced at the workflow layer, but single-lead project behavior is not yet fully surfaced and enforced end-to-end in UI/runtime behavior.
- Runtime reliability is improved, but the shipped bridge is still not a full runtime adapter comparable to Mission Control’s lifecycle/gateway stack.

Still missing:

- Architectural boundary tests that prevent route-level transport drift.
- A dedicated runtime/cooperation service layer under `src/lib/openclaw/` or equivalent.
- Full replacement of the example bridge posture with a production-grade runtime adapter.
- `sync` / `repair` companion flows beyond `bootstrap` and `doctor`.
- Removal of the remaining legacy chat mirror once webhook/back-compat strategy is finalized.

## Status Update

This plan has advanced beyond the earlier snapshot above.

Newly completed since the original status block:

- `sync`, `repair`, and `session-inspect` now exist in the local companion alongside `bootstrap` and `doctor`.
- Core MCP runtime routes now delegate into `src/lib/openclaw/` instead of owning task claim, result, heartbeat, and message-send behavior inline.
- Scoped resources now exist for `company`, `customer`, `project`, and `agent` contexts, with MCP routes for customer/project/global resource management and explicit lease logging.
- Project agent profiles now exist as a first-class MCP surface so a shared worker can still assume project-specific customer identity, signature, memory seed, and resource policy.
- Artifact storage now carries explicit classification and importance fields so source documents, proofs, templates, working files, and canonical deliverables stop collapsing into one generic bucket.
- The public install flow and shipped skill now describe persisted bridge state, reconnect backoff, dedupe behavior, scoped resources, and artifact hygiene, and the published skill is at `1.14.13`.
- Architecture tests now enforce those route boundaries.
- MCP recurring-task definition CRUD and manual spawn routes now exist per project.
- The recurrent lane is now backed by recurring-task definitions so spawned execution tasks can stay in the normal workflow lanes.
- The shipped Node and Python bridge examples now act as honest minimal runtime adapters instead of pure reference shells.

Still intentionally minimal:

- The bridge still needs a real executor integration to become a production-grade runtime.
- Legacy `chat_messages` mirroring remains for compatibility and inbound webhook flow.
- Recurring-task support includes definitions plus manual spawn, but not an automatic scheduler loop yet.
- Lead/worker behavior is enforced more strongly in the backend than in every human-facing UI surface.

## Next Architecture Wave

This section captures the next set of changes discussed after the initial Mission Control alignment work.
These are not optional polish items. They are the changes needed to make Emperor reliable for customer-facing operational use cases like invoice inboxes, customer-specific identities, mailbox access, durable thread history, and clean file handling.

## New Product Assumptions

1. Emperor must persist durable operational history.
   - Human-to-agent threads
   - Agent-to-agent threads
   - Task notes and handoffs
   - Task results
   - Approvals
   - Artifacts
   - Agent memory checkpoints
   - Session and lifecycle records

2. OpenClaw remains transient runtime.
   Emperor remains the durable control plane.

3. Not every agent should be shared.
   Customer-facing or project-facing identities often need dedicated context, credentials, and memory boundaries.

4. Shared workers are still useful.
   Generic capability agents can be reused across customers and projects as long as their resource access is scoped safely.

5. Artifact storage must distinguish important business files from temporary runtime exhaust.

6. Every control-plane contract change must update:
   - the skill package
   - the bridge examples
   - the public installer path
   - the public `/setup` page

## Customer / Project Scoped Identity and Resources

The current agent-centric integration model is not enough for customer-facing operations.
For examples like invoice inbox processing, customer-specific email access, and company-specific sender identity, resources should not live only on generic agents.

### Target model

- `company`
- `customer`
- `project`
- `project_lead_agent`
- `shared_worker_pool`
- scoped resources

### Resource scopes to support

- `company`
- `customer`
- `project`
- `agent`

### Resource examples

- mailbox credentials
- sender name / signature
- billing identity
- invoice templates
- external account credentials
- policy presets
- compliance instructions

### Recommended operating pattern

- One Emperor/OpenClaw runtime installation per company
- One or more dedicated lead identities per customer-facing project or stable customer function
- Shared workers for generic capability work
- Customer/project-scoped resources leased into the active lead/worker context when needed

### Schema / API additions

Add new tables or equivalent models for:

- `resource_scopes`
- `customer_resources`
- `project_resources`
- `resource_leases`
- `project_agent_profiles`

Where:

- `project_agent_profiles` defines the identity/persona/role for the lead in that workflow
- `customer_resources` and `project_resources` hold scoped credentials, templates, and business settings
- `resource_leases` records every runtime access to those scoped resources

### UI additions

- customer-level resource management
- project-level resource management
- lead identity/profile editor
- resource access audit history

### Success criteria

- a customer finance lead can use that customer's invoice mailbox and signature without cloning every worker
- a worker can execute under customer/project context without permanently owning those credentials
- customer identity, mailbox, and memory boundaries remain isolated

## Durable Persistence Rules

The system must be explicit about what gets persisted where.

### Canonical persistence rules

- `thread_messages`
  - what was said
  - human-to-agent, agent-to-agent, project/task/incident threads

- `task_events`
  - what happened
  - state transitions
  - handoffs
  - notes
  - retries
  - approval triggers

- `agent_memory_entries` / `agent_memory_snapshots`
  - what should persist as reusable memory or checkpoints

- `artifacts`
  - actual business files and documents

- `action_runs` / `action_steps`
  - runtime process telemetry

### Rules to enforce

- chat history must not be stored as artifacts
- task logs must not be stored as artifacts
- working memory must not be reconstructed only from chat
- reconnect logic must resume from durable Emperor state, not from hopeful local memory

### Success criteria

- all important conversations and operational records survive runtime restarts
- a dropped OpenClaw session does not erase customer/project context

## Reconnect, Retry, and Idempotency Plan

The bridge and client path must become more defensive against dropped connections and duplicate work.

### Runtime reconnect policy

- bounded backoff
  - 2s
  - 5s
  - 10s
  - 20s
  - cap at 60s
- do not spin in tight reconnect loops
- reconnect must always trigger state sync before resuming active work

### Reconnect flow

1. detect websocket drop
2. back off
3. reconnect runtime channel
4. revalidate runtime/session state
5. run `sync`
6. compare local checkpoint against Emperor state
7. resume or abandon stale work explicitly

### Idempotent write paths to harden

- task claim
- task result
- approval request
- thread send
- task note
- handoff note
- checkpoint writes
- artifact create

### Safety rules

- websocket is signal, not truth
- Emperor state is truth
- one active processing loop per claimed task
- no automatic duplicate claim on reconnect if the task is already owned by the same session lineage
- heartbeats renew leases but do not create duplicate execution loops

### Client / bridge updates required

- persist local runtime state file under the companion directory
- record active tasks, last checkpoint ids, last seen thread markers, and reconnect generation
- add dedupe markers for thread sends and task notes when reconnecting

### Success criteria

- dropped connections recover without task duplication
- runtime loops do not spiral into repeated messages/results/checkpoints
- a bridge reconnect does not create fake extra work or flood the control plane

## Artifact and File Management Cleanup

The current artifact model is useful but too loose for serious multi-customer use.

### Current problem

`artifacts` mixes:

- inline text payloads
- external file pointers
- working outputs
- final deliverables
- proof/evidence
- templates

This will create pollution over time.

### Target principles

- logs are not artifacts
- chat is not artifacts
- runtime telemetry is not artifacts
- proofs reference artifacts but are not the same thing
- important business files must be easy to distinguish from temporary exhaust

### Proposed refactor

Keep or evolve toward these layers:

1. `blob` / `file_object`
   - immutable stored payload metadata
   - hash
   - size
   - mime
   - storage key/provider
   - original filename

2. `artifact`
   - business meaning
   - title
   - role/classification
   - scope
   - visibility
   - retention
   - source
   - promoted/canonical flag

3. `artifact_version`
   - revision chain for important docs

4. `artifact_collection`
   - bundles/manifests such as monthly invoice packs

### Required classifications

- `source_document`
- `working_file`
- `proof`
- `deliverable`
- `template`
- `export_bundle`

And an importance dimension:

- `temporary`
- `operational`
- `record`
- `canonical`

### Required behavior changes

- stop hashing `storageUrl` as if it were file content
- store real content hashes from bytes
- prefer object storage for large files
- keep only small text/json/markdown inline in DB
- expose a promoted/canonical view in the UI
- hide temporary exhaust by default

### Success criteria

- invoice PDFs, merged bundles, ledgers, templates, and proofs remain organized
- temporary OCR/intermediate outputs do not pollute the main document surface
- operators can tell what is final vs transient without opening every record

## Concrete Use-Case Pattern: Invoice Inbox

This is the recommended structure for the invoice scenario discussed.

### Modeling

- Customer: real business customer
- Project: `Accounts Payable` or equivalent workflow surface
- Lead agent: dedicated finance/project lead identity
- Shared workers:
  - invoice extraction
  - reconciliation
  - document generation
  - classification

### Scoped resources

- customer/project mailbox
- billing information
- invoice templates
- sender identity

### Recurring workflow

- collect invoice emails
- ingest attachments
- classify and extract
- reconcile / group
- create merged package
- create ledger document
- optionally request approval

### File outputs

- source invoices: `source_document`
- extracted JSON/OCR: `working_file`
- validation evidence: `proof`
- merged invoice pack: `deliverable`
- ledger/export: `canonical`

## Public Install and Skill Update Policy

Every architecture change above has external integration implications.
The plan must explicitly keep the public install and skill contract in sync.

### Files that must be updated whenever runtime/control-plane semantics change

- `clawhub/emperor-claw-os/SKILL.md`
- `clawhub/emperor-claw-os/examples/bridge.js`
- `clawhub/emperor-claw-os/examples/bridge.py`
- `clawhub/emperor-claw-os/references/*`
- `scripts/control-plane.js`
- `public/install.sh`
- `public/install.ps1`
- `src/app/setup/page.tsx`

### Public install requirements

The default public path should remain:

1. install skill from ClawHub
2. visit `/setup`
3. download `install.sh` or `install.ps1`
4. run installer
5. run doctor
6. start generated bridge launcher

### Contract update rule

If resource scope, artifact semantics, reconnect behavior, or session behavior changes:

- bump the skill version
- publish to ClawHub
- refresh mirrored public files
- verify `/setup` and public installer downloads still match the shipped bridge behavior

## Execution Order For This Next Wave

This is the recommended order.

1. Add scoped resource models and lease logs
2. Add project/customer lead identity profiles
3. Harden bridge reconnect + dedupe + local state reconciliation
4. Formalize canonical persistence rules in code and docs
5. Refactor artifact/file model for classification and canonical promotion
6. Update public setup/install flow and companion state handling
7. Update skill package, examples, and references
8. Publish skill

## Definition Of Done For This Wave

This wave is done when:

- customer/project-specific identities and mailbox access are modeled cleanly
- durable thread/task/memory state survives reconnects and restarts
- reconnects do not duplicate work
- artifacts distinguish final business documents from temporary exhaust
- public install/setup flow still works and matches the actual bridge contract
- the skill package documents the real behavior and has been republished
