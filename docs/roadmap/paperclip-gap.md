# Paperclip gap analysis and backlog

Researched 2026-10-23 against `paperclipai/paperclip@master` (README, `docs/`, `ui/src`) and EmperorClaw `main` plus the uncommitted working tree. Paperclip claims come from their README and repo docs. UI claims come from file names and string literals in `ui/src`; nothing was run. `docs.paperclip.ing` was not fetched page by page. The same guides live in the repo under `docs/guides/**`, and those are the sources linked below.


## 1. Summary

- **Paperclip is ahead on the task as the unit of work.** Each issue has a thread, a run ledger with liveness states, documents with anchored comments, work products and blockers, and every mutation goes to an activity log. Our tasks are rows in a Kanban drawer, and the run timeline exists only per agent.
- **Paperclip is ahead on attention and navigation.** It has an Inbox with Mine/Unread/Blocked and j/k/archive keys, a Decisions queue, a command palette, a `?` shortcut sheet and full-text search over tasks, comments, documents and artifacts. We have none of these. Our attention surfaces are a notification bell plus Approvals.
- **Paperclip is ahead on routines.** It has server-side cron, webhook and API triggers, concurrency (`coalesce_if_active`/`skip_if_active`/`always_enqueue`) and catch-up policies, and revisioned definitions with restore. Each run is a tracked issue. Our pipelines and recurring tasks *describe* a cron, but the agent's runtime fires it. Hermes cron jobs are invisible to Emperor.
- **Paperclip is ahead on org and portability.** It has a strict `reportsTo` tree with chain of command, escalation up and delegation down, and hire approvals. Company packages export and import (markdown) with secret scrubbing, and imports land paused. It also has a Team Catalog.
- **Paperclip is ahead on cost views.** Costs break down by agent, project, provider and biller, with budget incidents. We have per-agent budgets and a pricing table only.
- **We are ahead on live visibility.** Per-agent "Right now", streaming reasoning and tool calls, and the chat live status row. Their `LiveRunWidget` is narrower.
- **We are ahead on reliability.** Durable delivery, leases, incidents, duplicate-runtime standby and a fast persistent Hermes gateway (~0.2 s).
- **We are ahead on scoped knowledge and clients.** Company Brain with `[[links]]`, a graph and per-client, per-project and per-agent scoping, plus Customers. Rich replies, desk display, voice and 38 MCP tools are also ours. Don't copy Paperclip here.

## 2. Gap table

| Feature | Paperclip | EmperorClaw today | Value | Effort | Prio |
|---|---|---|---|---|---|
| Task detail page with trace | `IssueDetail.tsx`, `IssueRunLedger.tsx` (liveness: advanced/plan only/empty response/needs follow-up), `IssueChatThread.tsx` | Drawer in `src/app/(app)/projects/projects-client.tsx` (1,417 lines) with `task_events` notes. No runs and no `/tasks/[id]` URL | High | M | P1 |
| Unified inbox | `Inbox.tsx` (All/Mine/Unread/Blocked, group/sort, archive), `WhatNeedsMe.tsx`, `BlockedInboxView.tsx` | `notification-bell.tsx` + `/approvals`. `agent_requests` and incidents live elsewhere | High | M | P1 |
| Command palette + shortcuts | `CommandPalette.tsx` (tasks/agents/projects/actions/pages), `KeyboardShortcutsCheatsheet.tsx` (`/`, `c`, `g i`, `j/k`, `?`) | missing | High | S | P1 |
| Global search | `pages/Search.tsx` ("tasks, comments, documents, artifacts, agents, projects") | Knowledge search only (`/api/mcp/knowledge`, `/resources`) | High | M | P1 |
| Navigation / IA | `Sidebar.tsx`: Search, Dashboard, Inbox, Chat / Work / Org (Agents, Skills, Connectors, Audit), Org chart, Costs, Activity | `src/components/app-sidebar.tsx`, `mobile-tab-bar.tsx`. No Inbox/Search, Costs hidden under Agents, Org nested | High | S | P1 |
| Hermes cron visibility | n/a (their routines are server-side) | Invisible. Jobs live in `~/.hermes/[profiles/<n>/]cron/jobs.json` per agent | High | M | P1 |
| Server-side routines + policies | [api/routines.md](https://github.com/paperclipai/paperclip/blob/master/docs/api/routines.md): triggers, concurrency, catch-up, revisions. `RoutineDetail.tsx`, `TriggerWizard.tsx` | `pipelines.trigger/triggerConfig` and `recurring_task_definitions.cronExpression` are descriptive. Spawn is agent-called via `/api/mcp/projects/[projectId]/recurring-tasks/[id]/spawn` | High | L | P2 |
| Activity / audit log | [activity-log.md](https://github.com/paperclipai/paperclip/blob/master/docs/guides/board-operator/activity-log.md), filters by agent/entity/time | `audit_log` table exists. Only `src/lib/mcp.ts` writes to it. No UI | Med | M | P2 |
| Cost views | `Costs.tsx`: by agent/project/biller/provider, incidents. [costs-and-budgets.md](https://github.com/paperclipai/paperclip/blob/master/docs/guides/board-operator/costs-and-budgets.md) | `src/components/budget-client.tsx`: per-agent budget + pricing. `agent_runs.costCents/taskId`, `agent_run_daily` unused for breakdowns | High | M | P2 |
| Org chart: reporting lines | [org-structure.md](https://github.com/paperclipai/paperclip/blob/master/docs/guides/board-operator/org-structure.md): `reportsTo`, chain of command, escalate up, no cycles. `OrgChart.tsx` zoom/fit | `organization-editor.tsx` + `src/lib/organization-tree.ts`: leader + team nodes stored in company config. No per-agent manager, no escalation path | Med | M | P2 |
| Goal ancestry | Goals page, `GoalTree.tsx`, tasks carry `goalId`/`parentId` ("why" context) | `projects.goal` text, `agent_objectives` (chat objectives), `goal-hub.tsx`. No company goals | Med | M | P2 |
| Company export/import | [importing-and-exporting.md](https://github.com/paperclipai/paperclip/blob/master/docs/guides/board-operator/importing-and-exporting.md): markdown package, secrets omitted, fidelity report, import paused | Agent role templates only (`src/lib/agent-templates.ts`) | Med | L | P2 |
| Skill Studio | `SkillStudio.tsx`: saved test inputs, run templates, version history/restore, fork | `agents.skillsJson`, `/api/skills/registry/*` | Med | L | P3 |
| Connector action permissions | README: gateway actions Allowed / Ask first / Off, standing rules | Approvals are task-level only | Med | L | P3 |
| Anchored doc comments | `DocumentAnnotationLayer.tsx`, `DocumentDiffModal.tsx` | Resource versions exist, no annotations | Low | M | P3 |
| Hire approvals | [delegation.md](https://github.com/paperclipai/paperclip/blob/master/docs/guides/board-operator/delegation.md) | Agents can create agents via MCP | Med | S | P3 |
| Atomic checkout | `POST /issues/{id}/checkout`, 409 never retried | Leases (`tasks.leaseOwner/leaseUntil`): equivalent | — | — | done |
| Budgets 80/100 | Same thresholds | Same (`agent-budget.ts`) | — | — | done |

## 3. Briefs (P1 and P2)

All briefs share these conventions. Next.js App Router in `src/app`, Drizzle schema in `src/db/schema.ts`, and migrations in `src/db/migrations/NNNN_*.sql` plus `meta/_journal.json` (next number is 0063 after `0062_direct-chat-mode.sql`). Tests go in `tests/unit`, `tests/integration` and `tests/e2e`. All UI copy is in English. Every query must stay company-scoped through `getCompanyId()` and role rules (owner/admin/member/viewer; restricted members see only assigned agents and customers). Per the release gates, re-check in a browser after any `page.tsx` or SQL change.

### P1-1 Task detail page with trace (2 slices)

**Goal.** Clicking a task opens `/projects/tasks/[id]`, a shareable page that shows everything that happened to the task in time order.

**Slice 1a: route + unified timeline**
- [ ] New `src/app/(app)/projects/tasks/[id]/page.tsx` (server) loads the task, project, customer, assignee, `blockedByTaskIds`, `task_events`, `approvals` via `approval_task_links`, `artifacts` on the task, and `agent_runs` where `taskId = id`.
- [ ] A `TaskTimeline` component merges these into one list: created, assigned, status change, note, approval requested/decided, run started/finished (duration, tokens, cost), artifact added.
- [ ] Each row has actor (human/agent), relative + absolute time and a deep link.
- [ ] The Kanban drawer in `projects-client.tsx` gets an "Open full page" link. Notes posting reuses `/api/tasks/[id]/notes`.
- [ ] 404 for other companies' tasks. Restricted members get 404 when not assigned.

**Slice 1b: inline run trace**
- [ ] Each run row expands to the existing `src/components/run-timeline.tsx` (tool calls from `agent_run_events` via `/api/runs/[runId]/events`).
- [ ] The header shows "now running" using `live-status-row.tsx` when a run is active.

**Data.** None. Index `agent_runs(task_id)` if missing.

**Tests.** Unit test for the merge/sort helper (`tests/unit/task-timeline.test.ts`). Integration test for the cross-company 404.

**Out of scope.** Anchored comments, editing the task inline beyond the existing drawer.

**Risks.** N+1 queries on long tasks. Cap at 200 events with "load older".

### P1-2 Unified inbox ("Needs me")

**Goal.** One place, `/inbox`, lists everything waiting on me: approvals, agent requests, open incidents, blocked tasks I own, @mentions. I can triage it fast.

- [ ] New `src/app/(app)/inbox/page.tsx` with tabs All / Approvals / Requests / Blocked / Mentions and an unread count.
- [ ] Items come from `approvals` (pending), `agent_requests` (open, via `src/lib/agent-requests.ts`), `incidents` (open), `tasks` (blocked and assigned to me or my agents), and `notifications` (mention type).
- [ ] Item actions: open, mark read, archive. Approvals can be approved or rejected inline using `src/lib/approvals.ts` (multi-task approvals render their task list).
- [ ] Keys: `j/k` move, `Enter` open, `e` archive, `r` read (registered via P1-3's hook once it lands; plain handlers before then).
- [ ] The badge in `use-nav-badges.ts` becomes the inbox total. `/approvals` stays as a filtered view.

**Data.** New `inbox_item_state(user_id, company_id, item_type, item_id, read_at, archived_at)` with a unique key. Items stay derived and are not copied.

**Tests.** Unit test for the source aggregator and state merge. Integration test that a viewer cannot approve.

**Out of scope.** Email digests, snooze.

**Risks.** Double counting against the bell. The bell should link to the inbox, not duplicate it.

### P1-3 Command palette + keyboard shortcuts

**Goal.** Ctrl/⌘+K jumps anywhere or runs an action without the mouse.

- [ ] `src/components/command-palette.tsx` built on the existing `src/components/ui` dialog (add `cmdk` only if not present). It is mounted in `src/app/(app)/layout.tsx`.
- [ ] Groups: Pages (every sidebar entry), Agents, Projects, Tasks (top 20 by recency, fuzzy), Actions (New task, New message to agent, Pause agent, Open inbox).
- [ ] `src/lib/use-shortcuts.ts` registers global keys and ignores them while typing in inputs, textareas and contenteditable. Keys: `⌘K`, `/` (search), `c` (new task), `g h/i/m/p/a` (home/inbox/messages/projects/agents), `?` (cheatsheet dialog).
- [ ] Results respect role scoping through a new `GET /api/ui/palette?q=`.

**Data.** None.

**Tests.** Unit tests for the fuzzy scorer and for input-focus suppression. One e2e test: open the palette, type an agent name, Enter navigates.

**Out of scope.** User-customisable bindings.

**Risks.** Conflicts with the markdown editor and chat composer shortcuts. Test on `/messages` and `/resources`.

### P1-4 Global search

**Goal.** `/search?q=` finds tasks, task notes, messages, knowledge notes, files and agents in one list, with type filters.

- [ ] Postgres FTS: generated `tsvector` columns + GIN on `tasks(title, description)`, `task_events(note text)`, `thread_messages(body)`, `scoped_resources(title, body)` and `artifacts(name)`.
- [ ] `GET /api/search` unions the results with type, snippet (`ts_headline`), link and score. It applies company scope and the restricted-member filter, and private direct chats (`src/lib/direct-chat-mode.ts`) are visible only to their participant.
- [ ] Page `src/app/(app)/search/page.tsx` has type chips, highlighted snippets and a zero-results tip.
- [ ] The palette's "Search for '…'" row opens this page.

**Data.** Migration with the generated columns + indexes. Confirm the real column names in `schema.ts` first.

**Tests.** Integration tests for: company isolation, private-chat isolation, restricted member, ranking sanity.

**Out of scope.** Semantic/vector search, searching attachment contents.

**Risks.** Migration time on large `thread_messages`. Use `CREATE INDEX CONCURRENTLY` in a separate migration.

### P1-5 Navigation revision

**Comparison.** Paperclip's `Sidebar.tsx` opens with an unlabeled attention cluster (Search, Dashboard, Inbox with a red tone on failed runs, Chat), then **Work** (Tasks, Projects, Routines, Artifacts, Goals, Workspaces), then **Org/Organization** (Agents, Skills, Connectors, Org, Costs, Activity, Settings). The company switcher sits at the top. Mobile (`MobileBottomNav.tsx`) is Home, Tasks, **New Task** (center action), Agents, Inbox. Two things work well for daily use: attention first, and Costs/Org/Activity as real destinations. The weak part is flag-driven sprawl, including duplicated "Connectors", beta items and two layouts. Ours is cleaner but has no Inbox or Search, hides Costs under Agents (`activeFor: ["/budgets"]`) and buries the org chart at `/agents/organization`.

**Proposed menu**
- (no header): **Home**, **Inbox** (badge; absorbs Approvals), **Messages**, **Search** (opens the palette)
- **Work:** Projects, Automations (pipelines + schedules + agent cron, see P1-6/P2-1), Files
- **Team:** Agents, Org chart (promoted), People (admin)
- **Company:** Customers, Knowledge base, Costs (promoted from `/budgets`), Activity (P2-2; hidden until shipped)
- Settings
- **Mobile tabs:** Home, Inbox, Messages, Projects, Agents. Approvals moves into Inbox, so phone approval stays one tap from the badge.

**Acceptance**
- [ ] `src/components/app-sidebar.tsx` and `mobile-tab-bar.tsx` updated. Items whose page doesn't exist yet are hidden behind a constant.
- [ ] `/approvals` keeps working (deep links from email, Slack and Discord notifications).
- [ ] The collapsed sidebar and the mobile dialog nav reflect the same sections.
- [ ] `use-nav-badges.ts` provides the inbox count.

**Tests.** Update `tests/ui-system.test.cjs` and `tests/operator-ux.test.cjs` if they assert labels. Add a unit test that each section's hrefs resolve to existing routes.

**Out of scope.** A center "New task" mobile action (P3).

**Risks.** Muscle memory. Ship together with P1-2 so Approvals never disappears without a replacement.

### P1-6 Hermes cron jobs visible in Emperor (2 slices)

**Goal.** On an agent's page I can see its own scheduled jobs (name, schedule, next/last run, last status, failures). I can later pause, resume and run them now, without SSH.

**Slice 6a: read-only sync**
- [ ] The bridge (`integrations/hermes/emperor-claw/bridge/emperor_bridge/`, new `cron_sync.py` wired in `main.py`) reads the profile's `cron/jobs.json` (path resolved like Hermes `get_cron_output_dir`; default `~/.hermes/cron/jobs.json`, named profile `~/.hermes/profiles/<name>/cron/jobs.json`) every 60 s and on file change.
- [ ] It posts a redacted snapshot to new `POST /api/mcp/runtime/cron-jobs`: `id, name, schedule_display, enabled, state, next_run_at, last_run_at, last_status, last_error (truncated), failure_streak, deliver`. The prompt is truncated to 500 chars. Never sent: `script`, `base_url`, env or other secret-bearing fields.
- [ ] A "Schedules" section in `agent-detail-panel.tsx` (or a new tab next to `agent-runs-tab.tsx`) lists the jobs. Stale data (>5 min) is flagged.
- [ ] The Automations page shows a read-only "Agent schedules" group.

**Slice 6b: controls**
- [ ] Pause, resume and run-now go through the existing agent control channel (`/api/agents/[id]/control`). The bridge applies them with Hermes `pause_job`/`resume_job`/`trigger_job` semantics (import from Hermes when available; otherwise write `jobs.json` under the same lock Hermes uses). Admin-only. Each action is written to `audit_log`.

**Data.** `agent_cron_jobs(company_id, agent_id, job_id, snapshot jsonb, synced_at)` unique `(agent_id, job_id)`.

**Tests.** Bridge pytest with a fixture `jobs.json` (redaction, missing file, malformed JSON). Integration test that a viewer can't control jobs.

**Out of scope.** Creating or editing jobs from Emperor, and cron output browsing (`cron/output/{job_id}/*.md`) for now.

**Risks.** The `jobs.json` schema is Hermes-internal and moves between versions (memory: don't `hermes update` past 0.22 yet). Parse defensively and pin to observed fields. Writes in 6b race the Hermes ticker, so prefer the Hermes API over raw file writes.

### P2-1 Server-side routines with policies (3 slices)

**Goal.** Recurring work fires from Emperor, not from whichever runtime happens to be up. Every firing becomes a tracked task with an owner and history.

- **2-1a scheduler:** a ticker in `src/lib/lifecycle.ts` (next to `startLifecycleMonitor`) evaluates active `recurring_task_definitions` and `pipelines` with `trigger='cron'` using `nextRunAt`. It claims rows with `UPDATE … WHERE next_run_at <= now() RETURNING` (multi-instance safe) and spawns through `spawnRecurringTaskInstance` in `src/lib/openclaw/tasks.ts`, which wakes the assignee (`src/lib/task-wake.ts`).
- **2-1b policies:** columns `concurrency_policy` (`coalesce_if_active` default | `skip_if_active` | `always_enqueue`), `catch_up_policy` (`skip_missed` default | `enqueue_missed_capped`) and `timezone`. Every firing writes a `routine_runs` row (`fired_at, outcome: created|coalesced|skipped, task_id`).
- **2-1c editor UI:** in `pipelines-client.tsx`, a trigger card with a cron builder plus a human-readable preview ("Mondays 09:00 Europe/Madrid"), the policy selects, the next 5 fire times and a run history list linking to P1-1 task pages. Also a "Run now" button.

**Acceptance.** A restart during the window follows the catch-up policy. Overlapping runs follow the concurrency policy. Agents that already self-schedule get an `executor: emperor|agent` flag, so nothing fires twice.

**Tests.** Unit tests for the next-fire calculation with timezones/DST and for each policy outcome. Integration test for two concurrent tickers with a single spawn.

**Out of scope.** Webhook/API triggers (P3) and revision history.

**Risks.** Double firing with agent-side cron. Default existing rows to `executor='agent'`.

### P2-2 Activity log

**Goal.** Admins can answer "who changed what, when" for agents, tasks, approvals, budgets and settings.

- [ ] A `src/lib/audit.ts` helper `recordAudit(companyId, actor, action, target, {before, after})` is called from: agent create/update/pause/delete, task status/assignee changes, approval decisions, budget edits, member role changes, org edits and routine changes.
- [ ] Page `src/app/(app)/activity/page.tsx` with filters for actor, target type and date range, and a before/after diff popover. Owner and admin only.
- [ ] `GET /api/activity` is paginated by `created_at, id`.

**Data.** Index `audit_log(company_id, created_at desc)`. `audit_log` already has `payloadJson`.

**Tests.** Integration test: a status change produces exactly one row, and other companies are invisible.

**Out of scope.** Export, retention tuning (handled by `src/lib/retention.ts` if desired).

**Risks.** Payloads must never include secrets (integration secrets, tokens). Add a redaction allowlist.

### P2-3 Cost views

**Goal.** "Where did the money go this month?" by agent, project, customer and model, over any date range.

- [ ] `/budgets` becomes Costs with tabs Overview (company total vs sum of budgets, daily spend chart from `agent_run_daily`), By agent (existing), By project, By customer (`agent_runs.taskId` → `tasks.projectId` → `projects.customerId`), By model (from `token_usage_log`).
- [ ] Date range picker (this month, last 30 days, custom).
- [ ] An "Unattributed" bucket for runs without a task (chat turns), so totals reconcile.
- [ ] Each row links to filtered runs.

**Data.** None for the first pass. Add an index on `agent_runs(company_id, started_at)` if missing.

**Tests.** Unit test that the breakdown totals equal the overview total.

**Out of scope.** Per-project budgets with enforcement (P3).

**Risks.** Chat-only agents will show mostly "Unattributed". Label it clearly as chat/objective work.

### P2-4 Org chart: reporting lines and escalation (2 slices)

**Goal.** Every agent has a manager, the chart shows it and agents know whom to escalate to.

- **4a:** derive `reportsTo` from the existing `OrganizationNode` tree in `src/lib/organization-tree.ts`. Validation already prevents malformed trees; add an explicit cycle check. Expose `chainOfCommand` in `organizationBriefing` (`src/lib/organization.ts`) so the agent context names its manager and skip-level. Add a read-only zoom/fit chart view with live status dots from `src/lib/agent-health.ts` on `/agents/organization`, keeping the editor behind an "Edit" toggle for admins.
- **4b:** MCP `escalate_task` (or `update_task` with `escalate: true`) reassigns a blocked task to the manager, writes a task event and notifies the human leader when the root is a person.

**Tests.** Unit tests for chain derivation and cycle rejection. A contract test in `tests/contract` for the new tool.

**Out of scope.** Hire approvals (P3) and cross-company org.

**Risks.** Nodes are stored in company config JSON, so keep that format as the single source and don't add a second `agents.reports_to` column that can drift.

### P2-5 Company goals and "why" context

**Goal.** Projects and tasks link to a company goal, so humans and agents see why work exists.

- [ ] Table `company_goals(id, company_id, title, description, status, parent_goal_id, owner_ref)` plus `projects.goal_id` (nullable; existing `projects.goal` text stays as the project brief).
- [ ] Goals list in the Projects page header. The project form gets a goal select. The task page (P1-1) shows a breadcrumb Goal › Project › Task.
- [ ] The goal title and ancestry are injected into agent task context (MCP `get_task` response).

**Tests.** Unit test for the ancestry builder (no cycles). Integration test for the scoping.

**Out of scope.** Auto-decomposition of goals by a lead agent.

**Risks.** Overlap with `agent_objectives`, which are chat-scoped follow-up loops. Name them differently in the UI ("Goal" vs "Objective").

### P2-6 Company template export/import (2 slices)

**Goal.** Package a working team (agents, roles, org, knowledge, pipelines) and recreate it in another company or instance.

- **6a export:** in Settings, "Export company" produces a zip of markdown + JSON with agents (name, role, instructions, skills, model), org config, groups, pipelines, recurring definitions, and optionally Company Brain notes. Secrets, tokens, integration credentials, runtime nodes, emails and customer data are never included. The UI shows a "Not included" list before download.
- **6b import:** preview, name collision handling, and everything lands paused (agents `paused`, pipelines `draft`). The final step is a checklist to activate.

**Data.** None (a `version` field in the manifest).

**Tests.** Export → import round-trip test. A secret-scrub test that greps the bundle for known secret fields.

**Out of scope.** GitHub import and a public catalog.

**Risks.** Leaking client knowledge. Brain export defaults off and excludes customer-scoped notes.

## 4. P3 / ideas

- Webhook and API routine triggers with HMAC signing and secret rotation (after P2-1).
- Routine definition revisions with restore.
- Skill Studio: saved test inputs, test runs and version history for agent skills.
- Connector action permissions: Allowed / Ask first / Off per tool, plus standing rules.
- Hire approvals when an agent creates an agent.
- Per-project budgets with hard stops.
- Run liveness labels on runs (plan only, empty response, needs follow-up) with bounded auto-continuation.
- Anchored comments and revision diffs on Company Brain notes.
- A center "New task" action on the mobile tab bar.
- Timeline/Gantt of runs per agent (Paperclip `Timeline.tsx`).
- A team catalog of installable starter teams, built on P2-6.
- Status cards (agent-written summaries pinned to the dashboard).
- Preview URLs and worktrees for coding agents. Low fit for our audience.
