# MCP Upgrade Plan

This plan captures the highest-value control-plane / MCP / UI improvements identified while integrating Emperor Claw with OpenClaw worker agents (Viktor and Manager).

## Goal

Move Emperor from:
- worker connectivity + chat + basic task progression

to:
- a cleaner multi-agent operating system with better assignment, delegation, resource ergonomics, and manager/worker coordination.

---

## Priority overview

### P1 — unblock real orchestration
1. Specific task assignment / claim by task ID
2. General task mutation surface
3. First-class agent profile / delegation registry
4. Cleaner resource content model (plain text / markdown first)

### P2 — improve multi-agent routing and context
5. Better scoped context retrieval
6. Stronger thread/delegation semantics
7. Manager / watchdog workflows as first-class MCP pattern

### P3 — polish and admin UX
8. Better installer/bootstrap/runtime ergonomics
9. Resource secret/env handling should be optional and likely disabled by default in early product stages

---

# 1) Specific task assignment / claim by task ID

## Problem
Current MCP supports:
- `POST /api/mcp/tasks/claim`

But that only claims the **next available task**.

It does **not** support:
- assign this exact task to this exact agent
- claim this exact task by id

That makes delegation clunky:
- Manager can say `@Viktor take TASK-1234ABCD`
- but the board cannot cleanly reflect that as an immediate targeted assignment/claim

## Goal
Support one or both:

### Option A — explicit assignment
- `POST /api/mcp/tasks/{id}/assign`
- body: `{ agentId, mode?: "assign" | "claim" }`

### Option B — claim specific task
- extend `POST /api/mcp/tasks/claim`
- body supports `{ agentId, taskId }`

## Recommendation
Prefer **Option A + Option B** eventually.

### Short-term
Implement:
- `POST /api/mcp/tasks/{id}/assign`

Behavior:
- validates task belongs to company
- validates agent exists
- updates `assignedAgentId`
- optionally moves state from `inbox` → `queued` or `in_progress` depending on semantics
- emits `task_updated`

### Medium-term
Extend claim route to allow:
- exact-task claim by id

This should preserve lease semantics.

## UI changes
- Task detail drawer: allow assign/reassign agent
- project board cards: visible assignment change immediately
- team thread/task detail should reflect assignment event

---

# 2) General task mutation surface

## Problem
Current MCP has a fragmented task interface:
- create task
- claim next task
- add notes
- submit result
- delete task

Missing:
- patch/update normal task fields cleanly
- assign owner
- move state intentionally outside result flow
- update title/goal/priority without ad hoc workarounds

## Goal
Add a real MCP task update surface.

## Recommendation
Add:
- `PATCH /api/mcp/tasks/{id}`

Allowed fields in v1:
- `title`
- `goal`
- `priority`
- `assignedAgentId`
- `state` (validated through workflow rules)
- maybe `inputJson`

## Rules
- validate transition legality
- require auth/company ownership
- broadcast `task_updated`
- keep idempotency support for write paths where needed

## UI changes
- task detail editor for title/goal/priority/state/assignee
- agent and project views reflect updates without refresh weirdness

---

# 3) First-class agent profile / delegation registry

## Problem
Right now agent definitions are improvised through local files or custom resource usage.

We proved a workable pattern using Emperor resources with plain text profiles in `configJson.profileText`, but it should become more native.

## Goal
Let Emperor be the source of truth for:
- role
- capabilities
- delegation graph
- thread policy
- task policy

## Recommendation
Support a first-class MCP concept for agent profiles.

### Lightweight path
Keep using resources, but make it explicit:
- `resourceType: "agent_profile"`
- top-level plain text content support
- optional structured metadata

### Stronger path
Add dedicated MCP routes:
- `GET /api/mcp/agent-profiles`
- `GET /api/mcp/agent-profiles/{agentId}`
- `POST /api/mcp/agent-profiles`
- `PATCH /api/mcp/agent-profiles/{agentId}`

## Content format
Use **plain text / markdown first**, not raw JSON as the primary authored form.

Suggested fields in authored text:
- Role
- Kind
- Purpose
- Can do
- Should not do
- Receives delegation from
- Delegates to
- Thread policy
- Task policy

## UI changes
- new Agent Profile panel/editor
- visible role/capability summary on agent pages
- delegation relationships visible in UI

---

# 4) Resource content ergonomics: plain text / markdown first

## Problem
Resources currently push users toward JSON-shaped config even when the content is really a human-authored text document.

That made agent profiles awkward.

## Goal
Make resources pleasant for:
- plain text
- markdown
- templates
- profiles
- notes

## Recommendation
Resources should support a first-class text body.

Possible model:
- `contentText`
- `contentType` (`text/plain`, `text/markdown`)
- `configJson` optional, not mandatory for the main content

## Important stance
Do **not** force JSON for text-oriented resources.
Plain text / markdown is better for:
- agent profiles
- templates
- prompt docs
- playbooks
- SOPs

## UI changes
- textarea/markdown editor for text resources
- JSON editor only when explicitly needed
- content preview tab

---

# 5) Better scoped context retrieval

## Problem
The bridge currently has to compose live context by piecing together:
- customers
- projects
- tasks
- resources
- profiles

There is no elegant MCP route for:
- give me the scoped operational context for this thread/project/agent

## Goal
Reduce prompt-glue logic in bridges and make context retrieval more native.

## Recommendation
Add a scoped summary route, for example:
- `GET /api/mcp/context?threadId=...`
- `GET /api/mcp/projects/{id}/context`
- `GET /api/mcp/tasks/{id}/context`

These should aggregate:
- customer/project/task basics
- recent notes
- relevant resources
- assigned agent
- thread info
- maybe agent profiles

## UI changes
- task/project detail pages can use the same context surface
- easier consistent summaries across UI and agents

---

# 6) Stronger thread / delegation semantics

## Problem
Threads exist (`team`, `direct`, `project`), but delegation semantics are still mostly inferred from text.

## Goal
Make it easier to distinguish:
- ordinary conversation
- direct human ask
- visible delegation
- worker handoff
- manager summary

## Recommendation
Add light metadata around messages or thread actions.

Possible approaches:
- optional message intent field (`conversation`, `delegation`, `status_update`, `blocker`, `summary`)
- explicit delegation action endpoint
- thread message metadata for `targetAgentId`, `taskId`, `intent`

### Short-term
At least let `messages/send` accept structured metadata safely.

## UI changes
- show delegation badge / intent label in thread
- filter operational updates vs normal chat

---

# 7) Manager / watchdog patterns as first-class MCP workflow

## Problem
Manager-like oversight is possible, but not first-class. We had to invent review loops in the bridge.

## Goal
Support:
- stale-task review
- idle-project review
- non-noisy escalation
- daily/periodic summaries

## Recommendation
Add a formal review/health-check pattern.

Possible surfaces:
- `GET /api/mcp/reviews/work-health`
- `POST /api/mcp/reviews/run`
- or project/company health summary endpoints

Return structured signals like:
- stale tasks
- blocked tasks
- idle projects
- overloaded backlog
- unowned work

## UI changes
- Work Health dashboard
- manager summary panel
- stale/blocked indicators on projects and tasks

---

# 8) Installer / bootstrap / runtime ergonomics

## Problem
The protocol is decent, but the operational layer needed hardening:
- multi-agent setup
- companion directories
- service naming
- bootstrap files
- dependency installation

## Goal
Make Emperor/OpenClaw integration easy for normal users.

## Recommendation
Installer should:
- support multiple profiles (`operator`, `manager`, later more)
- use per-agent companion dirs
- use per-agent systemd service names
- generate dedicated agent bootstrap packs
- validate end-to-end doctor + local brain path

### Runtime asset publishing
Serve raw runtime JS assets cleanly; do not force workarounds where install URLs return app HTML.

## UI changes
- setup wizard / docs for operator + manager profiles
- health/status page for bridged agents
- clear visibility into runtime id, service, and recent sync state

---

# 9) Resource env/secret handling should be optional or disabled by default

## Problem
Resources can carry sensitive config, but early product ergonomics may push people toward storing env-like material too casually.

## Recommendation
For now:
- make secret/env-style resource usage **optional**
- possibly keep it **disabled by default** in UI for most users until the model is clearer

## Why
This reduces:
- accidental secret sprawl
- confusing resource semantics
- premature coupling of resources to credentials

## Better default
Start with resources being great for:
- text profiles
- templates
- SOPs
- non-secret operational docs

Then layer in secret-bearing resources later with stronger UI/permission design.

## UI changes
- explicit “secret resource” toggle instead of silent default behavior
- warning text and permission model for secret-bearing resources
- plaintext/markdown resource mode should be the obvious default for non-secret docs

---

# Suggested implementation order

## Phase A — unlock orchestration
1. specific-task assignment / claim-by-id
2. general task patch/update route
3. resource text-body ergonomics
4. agent-profile first-class support

## Phase B — make multi-agent workflows cleaner
5. scoped context retrieval
6. stronger delegation/thread semantics
7. manager/work-health support

## Phase C — operator experience
8. installer/runtime/health polish
9. secrets/resources UX hardening

---

# Immediate product stance

If we had to choose right now:
- **plain text / markdown resources are better than forced JSON** for authored operational data
- **env/secret-style resource storage should be optional or even hidden/disabled by default** until the permissions and UX are cleaner
- **specific task assignment by id** is the most important missing MCP upgrade

---

# Success criteria

Emperor should feel ready when users can:
- define agents centrally in Emperor
- delegate specific tasks to specific agents
- see assignment change in UI immediately
- let Manager assign/coordinate workers safely
- store agent profiles and SOPs in readable markdown/text
- avoid secret misuse by default
- install operator/manager bridges without hand-editing local setup
