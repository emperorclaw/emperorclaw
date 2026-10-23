# Product decisions: what EmperorClaw takes from Paperclip

Written 2026-10-23. It builds on [paperclip-gap.md](./paperclip-gap.md) and corrects it where it was wrong.

**Sources.** On the Paperclip side I read `ui/src/components/Sidebar.tsx`, `MobileBottomNav.tsx`, `IssueRunLedger.tsx`, `CommandPalette.tsx`, `ui/src/pages/Inbox.tsx`, the README, `docs/api/routines.md` and `docs/guides/board-operator/costs-and-budgets.md` from `paperclipai/paperclip@master`. I also read the issue tracker sorted by reactions and by comments, plus issues #923, #7801 and #14600. Paperclip was not run. For EmperorClaw I read the files named inline. Anything marked *(unverified)* comes from the earlier gap doc and was not re-read today.

**Corrections to the gap doc**
- It says we have no inbox. **That is wrong.** The dashboard already has an "Action inbox" (`src/components/team-dashboard/needs-attention.tsx`), built in `src/app/(app)/page.tsx:308-394`. It merges stuck tasks, offline agents holding work, late and not-started tasks, approvals, failed or unanswered messages and paused loops. It sorts them by urgency and lets you approve, reject, dismiss, restart, resume or reassign inline, and it confirms before you approve a stale request. What's missing is narrower: the inbox has no URL, no per-user read/archive state, no place in the nav, and the badge counts only approvals and unread messages (`src/components/use-nav-badges.ts`).
- Paperclip's catch-up policy is called `enqueue_missed_with_cap`, not `enqueue_missed_capped` ([routines.md](https://github.com/paperclipai/paperclip/blob/master/docs/api/routines.md)).
- Paperclip's run ledger shows **no tokens or cost per run** (`IssueRunLedger.tsx`). Ours does (`src/components/run-timeline.tsx`), so this is an advantage of ours, not a gap.
- Their costs guide doesn't describe "budget incidents". Their Inbox does raise a budget alert at 80% or more. *(The Costs page itself is unverified.)*

---

## 1. Positioning thesis

**Paperclip** is for people building *autonomous companies*. The model is a CEO agent, an org chart, heartbeats and a long list of adapters (Claude Code, Codex, Cursor, Gemini, OpenCode, Hermes, Pi and more; see the [README](https://github.com/paperclipai/paperclip)). Its users lean towards developers, and its tracker reflects that. The most-reacted requests are new model adapters (Ollama #187, OpenRouter #1068, Z.AI #1130), and the most-commented bugs are adapter and runtime failures (#8723, #14093, #4046).

**EmperorClaw** is for **teams and agencies that deliver real client work with agents**. They host it themselves, run Hermes agents fast, need delivery to be reliable, keep each client's work apart, give agents a shared company brain, and approve things from their phone. We should not try to beat Paperclip on adapter count or the autonomy metaphor. We should beat it on **trust in delivery**.

### The three reasons to pick EmperorClaw

| # | Reason | What must be true in the product for the reason to hold | Today |
|---|---|---|---|
| R1 | **Nothing goes silent.** You always know what each agent is doing, why it's waiting, and that a message or task won't vanish. | (a) Every task has a page that tells its whole story, runs included. (b) An agent that stops making progress is flagged in the UI before a human notices. (c) Every scheduled job, including Hermes cron, is visible. (d) Every stall reaches the inbox with a reason and an action. | Live status is strong: the Right now card, the live row and streamed steps. Durable outbox and incidents exist. There's no task page, Hermes cron is invisible, and there's no "no progress for N min" signal. |
| R2 | **Client work stays separate and accountable.** One install, many clients, each with its own work, files, knowledge, people and costs. | (a) Cost per customer and per project. (b) The inbox and search respect restricted members and private chats. (c) An activity log answers "who changed what". (d) Export never leaks client data. | Scoping is strong: Customers, restricted members, a scoped Brain. Costs exist only per agent (`src/components/budget-client.tsx`). `audit_log` is written only from `src/lib/mcp.ts`, and nothing shows it. |
| R3 | **Run the team from your phone.** Approve, unblock and check in with one thumb. | (a) The inbox is a mobile tab with a badge that is the *true* count. (b) Every inbox item can be acted on inline on a phone. (c) The task page is readable at 375 px. | Approvals is a mobile tab today (`src/components/mobile-tab-bar.tsx`). The Action inbox lives only on the dashboard and isn't a tab. The inline actions are already 44 px touch targets (`min-h-11`). |

Paperclip's own tracker shows these are real pains. "Invisible, undebuggable" holds left tasks idle with no visible reason ([#14600](https://github.com/paperclipai/paperclip/issues/14600)). A skipped handoff stalled "silently" (#13532). A task became "unrecoverable" after a cancellation (#13640). Inbox badges went stale ([#3145](https://github.com/paperclipai/paperclip/issues/3145), [#314](https://github.com/paperclipai/paperclip/issues/314)). Approvals weren't in the primary navigation (#4254), and a user-participant approval stage had no action buttons (#4143). One user wrote "Inbox gets noisy" and asked that agents open a task assigned to the human when they're blocked ([#923](https://github.com/paperclipai/paperclip/issues/923)). Each of these maps onto R1 or R3.

---

## 2. Decision table

Value and effort are H/M/L. The "Reason" column says which of R1, R2 or R3 the item strengthens.

| Candidate | Paperclip's approach | Their users' feedback | Ours today | Verdict | Value / Effort | Reason |
|---|---|---|---|---|---|---|
| **Navigation / menu** | `Sidebar.tsx`: unlabeled top cluster (New Task button, Search, Dashboard with a live-run count, Inbox with an unread count that turns red on failed runs), then collapsible **Work** and **Org**, then live lists of agents and recent tasks. Company switcher in the header. | Approvals not in primary nav (#4254). Stale badges (#3145, #314). | `app-sidebar.tsx`: Work / Team / Company. Approvals and Messages carry badges. No Inbox or Search. Costs hidden under Agents (`activeFor: ["/budgets"]`). | **Adapt** (section 3). | H / S | R1, R3 |
| **Task page + trace** | `IssueRunLedger.tsx`: run cards with status, liveness label, Elapsed / Last useful action / Stop reason, "live" badge, output-silence banner with Snooze or False-positive. Activity interleaved, 20 items, no collapsing, no cost. | Silent stalls (#14600, #13532). | Drawer in `src/app/(app)/projects/projects-client.tsx` (1,355 lines) with `task_events`. No URL, no runs. Links go to `/projects?task=`. | **Adopt the page, adapt the ledger** (section 4). | H / M | R1 |
| **Inbox** | `Inbox.tsx`: Mine / Recent / Unread / Blocked / All. Failed runs reduced to the latest per agent, with Retry and Dismiss. Archive with 5 s undo. Sort pinned so rows don't jump. j/k/a/r/U keys. | "Inbox gets noisy" (#923). Badge drift (#3145). | The dashboard Action inbox (see corrections). | **Adapt.** Promote ours to `/inbox` and keep its urgency sort and inline actions. Add read/archive state, agent requests and failed runs. Steal "pinned sort, undo archive". Keep **"needs a decision"** separate from **"FYI"** (we already split Action inbox from Watchlist). | H / M | R1, R3 |
| **Command palette / shortcuts** | `CommandPalette.tsx`: ⌘K. Groups Search / Actions / Pages / Tasks / Agents / Projects. Server-side task search, client-side fuzzy match on projects. | none found | none. `cmdk` isn't a dependency (checked `package.json`). | **Adopt, small.** Pages, agents, projects, recent tasks and 4 actions, on the existing `ui/dialog`. Only `⌘K`, `?`, `g`-chords. | M / S | power users |
| **Global search** | `pages/Search.tsx` *(unverified)* | none found | Knowledge search only | **Adopt later (0.11).** Postgres FTS that respects scoping. It's a must for R2 once there are many clients. | H / M | R2 |
| **Org chart** | `OrgChart.tsx` and a `reportsTo` tree, CEO at the top *(unverified)* | "CEO agent stuck in missing permission" (#101) | `/agents/organization`, `src/lib/organization-tree.ts` | **Adapt minimally.** Derive a manager per agent for escalation (#923 shows the value). Don't make the chart a headline feature or adopt the CEO metaphor. | M / M | R1 |
| **Goals** | Flag-gated sidebar link, `GoalTree.tsx` | none found | `projects.goal` text, `agent_objectives` | **Skip a goal hierarchy.** For an agency, the client and the project *are* the "why". Show the project goal in the task page header instead. | L / M | — |
| **Costs pages** | Summary, per-agent and per-project views. Company and agent budgets at 80% and 100% ([guide](https://github.com/paperclipai/paperclip/blob/master/docs/guides/board-operator/costs-and-budgets.md)). | Subscription vs API cost (#339, #498). Token budgets (#1756). | Per-agent budget and pricing (`budget-client.tsx`) | **Adopt with our own axis:** by **customer** and project (they don't have a by-client view). Label subscription-billed runs as "estimated" (#339). | H / M | R2 |
| **Routines / server-side scheduling** | Schedule, webhook and api triggers. `coalesce_if_active`, `skip_if_active`, `always_enqueue`. `skip_missed`, `enqueue_missed_with_cap`. Each accepted run creates an issue ([routines.md](https://github.com/paperclipai/paperclip/blob/master/docs/api/routines.md)). | none found | Pipelines and recurring definitions *describe* a cron. The agent fires it. | **Adopt the policy model in 0.12**, schedule triggers only. "Every firing is a task" is exactly R1. | H / L | R1 |
| **Hermes cron visibility** | n/a | n/a | Invisible. The bridge doesn't read cron (no `cron` in `emperor_bridge/`). | **Build (ours only).** Read-only sync first. Paperclip can't do this as well because it doesn't own the Hermes bridge. | H / M | R1 |
| **Activity / audit log** | `/activity` ("Audit") in the Org section | none found | `audit_log` table, written only by `src/lib/mcp.ts` | **Adopt.** Admin-only, with a redaction allowlist. | M / M | R2 |
| **Skills studio** | `SkillStudio.tsx`: test inputs, versions, fork *(unverified)* | none found | `skillsJson`, skills registry | **Skip** for now (section 6). | L / L | — |
| **Templates / export-import** | Markdown company package, secrets scrubbed, imports land paused *(unverified)* | none found | Role templates (`src/lib/agent-templates.ts`) | **Adapt in 0.12:** export a *team* (agents, org, pipelines). Brain export off by default and never customer-scoped. Agencies clone a setup per client. | M / L | R2 |
| **Connection permissions** | Allowed / "Ask first" / Off per gateway action (README) | none found | Task-level approvals | **Later (post-0.12).** Valuable for client safety, but it needs tool-gateway plumbing we don't have. | M / L | R2 |
| **Anchored comments** | `DocumentAnnotationLayer.tsx` *(unverified)* | none found | Resource versions | **Skip.** | L / M | — |
| **Plugins** | Sidebar plugin slots, launcher outlets (`Sidebar.tsx`) | none found | MCP tools (38) | **Skip.** MCP is our extension surface. | L / L | — |
| **Test-drive / demo onboarding** | Onboarding adapter cards (#4158 is about promoting one) | Confusion at first run (#469, #101) | Describe-company → hire flow (README steps 01–03) | **Adapt cheaply:** a "sample client" seed with one project, two tasks and one pending approval, so the inbox and task page aren't empty on day one. | M / S | R3 |
| **Failed-run retry in the inbox** | Inbox failed-run row with Retry and Dismiss and human copy ("Reconnect account", "Budget limit reached") | — | Message failures show "Inspect delivery" | **Adopt the copy pattern:** one plain-language cause plus one fix button per failure type. | H / S | R1, R3 |
| **Output-silence watchdog** | Silence banner with Continue / Snooze 1h / Mark false positive (`IssueRunLedger.tsx`) | #14600 | none | **Adopt simplified:** "No progress for 6 min" on the Right now card and task page, plus an inbox entry past a threshold. | H / S | R1 |
| **Favorites / pinned** | Starred projects under Projects | Favorites request (#7801), deferred by the maintainer | none | **Adapt later:** pin *customers* in the sidebar, which fits agencies better. | M / S | R2 |
| **Agent blocked → human task** | Proposed, PR #1977 open | #923 | Incidents and `agent_requests` | **Adopt in 0.12:** an agent request becomes an inbox item with an owner. It already almost is. | H / S | R1 |
| **Live agents and recent tasks in the sidebar** | `SidebarAgents`, `SidebarRecentTasks` (live-run aware) | Status clarity in the sidebar list (#689) | none | **Skip for desktop.** Our dashboard desk and Right now card do this better, and sidebar lists get noisy past about 8 agents. | L / S | — |

---

## 3. Navigation

### What works in Paperclip's menu (probably the "something" you like)

1. **The attention cluster has no header, and it comes first.** Search, Dashboard and Inbox sit above every labeled section, so the first three rows answer "what needs me".
2. **Badges carry meaning, not just numbers.** Dashboard shows a *live-run* count, so the sidebar shows the company is working. Inbox turns **red when runs failed**, which separates "unread" from "broken".
3. **A primary action sits in the nav.** "New Task" on desktop, and a centered New Task on mobile (`MobileBottomNav.tsx`).
4. **Sections collapse.** Work and Org can be folded away.
5. **Admin-ish destinations are real items.** Costs and Activity have their own rows instead of hiding inside tabs.

### What doesn't work

- **Flag sprawl.** There are two shells ("legacy" and "streamlined"), about seven feature-flagged rows, "beta" badges, Chat in two possible positions and Connectors in two sections. The mobile bar reshuffles with flags too: the New Task button stops being centered when Inbox and Tasks merge. Users get a different menu depending on settings.
- Collapse state only lasts for the session.
- **Badge drift** in two closed bugs (#3145, #314). The badge and the inbox were computed from different sources.
- Approvals were hard to find (#4254). **We already do this better**, since Approvals is first-class for us today.

### Recommended IA

Rules. One shell and no flags in the menu. The attention cluster comes first. The badge is computed by the same function that builds the inbox. Sections can be collapsed and the state is saved in `localStorage`. A section is never empty: items whose page doesn't exist yet are hidden.

```
DESKTOP SIDEBAR (expanded)
┌──────────────────────────────┐
│ EMPEROR CLAW      [⌘K Search]│  ← search pill opens the palette
│ [+ New task]                 │  ← primary action (opens the drawer)
│                              │
│ ▣ Home              ● 3 live │  ← live-run count (cyan, not red)
│ ▣ Inbox                  (5) │  ← true inbox count; red if anything failed
│ ▣ Messages               (2) │  ← unread
│                              │
│ ▾ WORK                       │
│   Projects                   │
│   Automations                │  ← pipelines + schedules + agent cron (0.11)
│   Files                      │
│ ▾ CLIENTS & KNOWLEDGE        │
│   Customers                  │
│     ★ Acme Corp              │  ← pinned customers (0.12)
│   Knowledge base             │
│ ▾ TEAM                       │
│   Agents                     │
│   Org chart                  │  ← promoted from /agents/organization
│   People            (admin)  │
│ ▸ ADMIN             (admin)  │  ← collapsed by default
│   Costs                      │  ← promoted from /budgets
│   Activity                   │  ← 0.11
│ Settings                     │
├──────────────────────────────┤
│ 🔔  user ▾   docs · theme · « │
└──────────────────────────────┘

MOBILE TABS (5, fixed order, never flag-dependent)
┌────────┬────────┬────────┬──────────┬────────┐
│  Home  │ Inbox  │Messages│ Projects │ Agents │
│        │  (5)   │  (2)   │          │        │
└────────┴────────┴────────┴──────────┴────────┘
Header: [logo]  ............  [⌕ search] [≡ menu]
```

**Why these choices**
- **Inbox replaces Approvals as the mobile tab.** Approvals become the "Approvals" filter of the inbox, and `/approvals` keeps working because email, Slack and Discord links point there. This is R3 in one tap.
- **No center "New task" on mobile.** Our phone usage is approve-and-check, not create. A FAB for New task belongs on the Projects screen.
- **"Clients & knowledge" is a section of its own.** That makes R2 visible in the menu itself. Paperclip has no client concept at all.
- **Live-run count on Home in cyan, failures in red on Inbox.** This is Paperclip's best idea and costs us one query.

---

## 4. The agent timeline

### Comparison

| | Paperclip (`IssueRunLedger.tsx`) | EmperorClaw |
|---|---|---|
| Scope | Per issue | Per agent (`agent-now-card.tsx`, `agent-runs-tab.tsx`) and per reply (`ReplyRunFooter` in `run-timeline.tsx`) |
| Live | 3–5 s polling, a "live" badge, elapsed time | Streamed steps with the tool running and its own timer, reasoning lines, a fixed-height live row (`live-status-row.tsx`). **Better.** |
| Per-step detail | Not in the ledger. "Inspect run" opens a dialog | Inline tool/reasoning/notice/compaction/subagent rows. **Better.** |
| Cost/tokens | Not shown | In, out, cached %, $, model, queue and first-token time. **Better.** |
| Outcome semantics | Liveness: Completed / Advanced / Plan only / Empty response / Blocked / Failed / Needs follow-up. Last useful action. Stop reason. | Raw status (`succeeded/failed/timeout/lost/cancelled/blocked`). No "did it move the task?" label. |
| Stall signal | Output-silence banner with watchdog actions | None, beyond the incident's "late"/"not started" on the dashboard |
| Task ↔ run ↔ message | Runs linked to the issue, child-issue summary | Right now links task to `/projects?task=`, and a reply links to its run. **A task never links to its runs.** |
| Density | Every card fully expanded, 20 items | Collapsed by default ("Steps (n)", the reply footer) |

**Keep:** streaming steps, the fixed-height live row, the collapsed-by-default footers, and cost on every run.
**Take:** a task-scoped view, an outcome label per run, "last useful action", and a stall signal.

### Target design: the task page "story"

Route: `/projects/tasks/[id]`. The drawer gets an "Open full page" link.

```
Acme Corp › Website relaunch › Write pricing page copy        [In progress]
Goal: "Launch new site by Nov 15" (project goal)   Owner: Growth (agent)

┌ NOW ────────────────────────────────────────────────────────────┐
│ ● Growth is working · 4m 12s · run 3                             │
│   Running web_search · "competitor pricing SaaS" · 8s            │  ← LiveStatusRow
│   Last useful action 40s ago                    [Steps (14) ▾]   │
└──────────────────────────────────────────────────────────────────┘

TODAY
 10:42  ▸ Run 3 · Growth · running · 4m · 14 steps · $0.08          (collapsed block)
 10:41    Note from Ana: "Use the new tier names"                   (human, full text)
 10:30  ▸ Run 2 · Growth · Advanced · 6m 10s · 22 tools · $0.21     ▸ expands to RunTimeline
          ↳ Reply in #website: "Draft v1 ready…"   [open message]   (message ↔ run link)
 10:29    Approval requested: "Publish draft?" → Rejected by Ana    (inline, with reason)
YESTERDAY
 17:05  ▸ Run 1 · Growth · No progress · 12m · 0 tools · $0.04      (amber)
 16:50    Assigned to Growth by Ana · Created
```

**Rules**
1. **One merged, time-ordered list** of task events, approvals, artifacts, runs and the messages produced by runs. Group by day. Newest first, with the live block pinned on top.
2. **A run is a collapsible block.** Its header is the existing `runFooterSummary` plus an **outcome label**, and expanding it mounts `RunTimeline` (lazy, as today). Human notes and decisions are always expanded. Runs are always collapsed, except the live one.
3. **Outcome labels.** Use four, not Paperclip's eight: **Advanced** (task state or note or artifact changed), **No progress** (ended with no task mutation and under 2 tools), **Failed**, **Waiting on you** (ended in an approval or agent request). Compute them on read from existing rows. Add no new columns until the labels prove useful.
4. **Stall signal.** "Last useful action N ago" is the last tool end or task mutation, not the last reasoning token. At 6 minutes it turns amber and the inbox gets a "No progress" item with *Nudge*, *Reassign* and *Stop*. Skip Paperclip's snooze and false-positive buttons for now.
5. **Links in both directions.** A run links to its reply message. Message footers get "on task: X" when `agent_runs.taskId` is set. The Right now card's task link goes to the task page.
6. **Cap:** 50 entries, then "Load older". Paperclip caps at 20.
7. **Mobile:** one column, run blocks full width, actions in a bottom sheet.

The Right now card stays per-agent and gains rule 4. The chat live row stays as it is. The task page becomes the third view of the same run data, so we don't build a new data model.

---

## 5. Build sequence

**M** = mechanical: clear spec, existing patterns, good for opencode/DeepSeek. **D** = needs design judgment: Claude or human review. Each slice fits one implementation run. Per the release gates, every slice that touches `page.tsx` or SQL needs a browser re-check.

### 0.10: "Needs me" (R1 and R3, no new data model)

| # | Slice | Type | Acceptance criteria and paths |
|---|---|---|---|
| 10.1 | **Extract the attention builder** | M | Move `src/app/(app)/page.tsx:308-394` into `src/lib/attention.ts` (`buildAttention(companyId, access)`). The dashboard renders exactly what it did before. Add a unit test for the urgency sort in `tests/unit/attention.test.ts`. |
| 10.2 | **`/inbox` page + true badge** | D | New `src/app/(app)/inbox/page.tsx`. It reuses `NeedsAttention` with chips for All / Approvals / Problems / Messages and adds the Watchlist below. New `GET /api/inbox/count` calls the *same* `buildAttention`. `use-nav-badges.ts` gains `inbox` and `inboxHasFailures`. The badge drops right after an inline action (refresh on success). `/approvals` is unchanged. |
| 10.3 | **Navigation revision** | M (after section 3 is approved) | `src/components/app-sidebar.tsx` and `mobile-tab-bar.tsx` follow section 3: collapsible sections saved under `emperor-sidebar-sections`, Costs promoted, Org chart promoted, Inbox replaces Approvals as the mobile tab. Add a unit test that every href resolves to an existing `page.tsx`. Update `tests/ui-system.test.cjs` and `tests/operator-ux.test.cjs` if they assert labels. |
| 10.4 | **Task page: merged timeline** | D | `src/app/(app)/projects/tasks/[id]/page.tsx`. The helper `src/lib/task-story.ts` merges `task_events`, approvals (via `approval_task_links`), artifacts and `agent_runs` where `taskId = id`, groups them by day and caps at 50. Cross-company or unassigned restricted members get 404 (integration test). The drawer gets "Open full page". `agent-now-card.tsx` and inbox links point here. |
| 10.5 | **Run blocks + outcome labels** | M | The run row in the task page collapses and expands to `RunTimeline`. `runOutcome()` in `src/lib/task-story.ts` returns Advanced / No progress / Failed / Waiting on you, with unit tests for each. The live run is pinned with `LiveStatusRow`. |
| 10.6 | **"Last useful action" + stall item** | D | `src/lib/live-activity.ts` exposes `lastUsefulAt`. The Right now card and the task page show it, amber at 6 min or more. `buildAttention` adds a `stalled` kind with Nudge (existing wake, `src/lib/task-wake.ts`), Reassign and Stop. No duplicate item when an incident already exists for the task. |
| 10.7 | **Command palette (minimal)** | M | `src/components/command-palette.tsx` on `@/components/ui/dialog`, mounted in `src/app/(app)/layout.tsx`. It offers Pages, Agents, Projects, the 20 most recent tasks (`GET /api/ui/palette?q=`, role-scoped) and actions (New task, Open inbox, Message agent). Keys `⌘K`, `g h/i/m/p/a`, `?`, all ignored inside inputs and contenteditable. Unit test for focus suppression. |

### 0.11: "Accountable" (R2 and R1)

| # | Slice | Type | Acceptance criteria and paths |
|---|---|---|---|
| 11.1 | **Hermes cron read-only sync** | D | Bridge `cron_sync.py` reads `jobs.json` defensively and sends only the redacted fields listed in gap P1-6. `POST /api/mcp/runtime/cron-jobs`, plus a `agent_cron_jobs` table and migration. A "Schedules" tab next to Runs in `agent-detail-panel.tsx` shows a stale flag after 5 min. pytest covers the fixture, redaction and malformed file. |
| 11.2 | **Costs by customer / project / model** | M | `/budgets` becomes Costs with tabs. Joins go `agent_runs → tasks → projects → customers`. An "Unattributed (chat)" bucket keeps totals reconciled (unit test). Subscription-billed runs are labelled "estimated". |
| 11.3 | **Audit helper + Activity page** | M | `src/lib/audit.ts` `recordAudit()` is called from agent update, pause and delete, task status and assignee changes, approval decisions, budget edits, role changes and org edits. It uses a redaction allowlist. `src/app/(app)/activity/page.tsx` is admin-only and paginated. |
| 11.4 | **Inbox state + keys** | M | `inbox_item_state` table (read/archived per user). Archive offers a 5 s undo. The sort stays pinned until refresh. Keys j/k/Enter/e/r. |
| 11.5 | **Global search (FTS)** | D | Generated `tsvector` columns and GIN indexes created `CONCURRENTLY`. `GET /api/search` enforces company scope, restricted members and private direct chats (integration tests for each). The palette gets a "Search for …" row. |
| 11.6 | **Failure copy per cause** | D | Message and run failures in the inbox show one plain cause plus one fix button: Reconnect runtime, Raise budget, Retry, Reassign. |

### 0.12: "Runs itself" (R1 and R2)

| # | Slice | Type | Acceptance criteria and paths |
|---|---|---|---|
| 12.1 | **Server-side schedule ticker** | D | A ticker in `src/lib/lifecycle.ts` claims due rows with `UPDATE … RETURNING` and spawns through `spawnRecurringTaskInstance` (`src/lib/openclaw/tasks.ts`). Existing rows get `executor='agent'`, so nothing fires twice. Integration test with two concurrent tickers. |
| 12.2 | **Policies + firing history** | M | `concurrency_policy` (`coalesce_if_active` default), `catch_up_policy` (`skip_missed` default, `enqueue_missed_with_cap`), `timezone`, and a `routine_runs` table. Unit tests cover DST and each outcome. |
| 12.3 | **Schedule editor UI** | D | In `src/app/(app)/pipelines/pipelines-client.tsx`: a human-readable preview, the next 5 firings, a history that links to task pages, and Run now. Hermes cron jobs from 11.1 are listed read-only in the same view. |
| 12.4 | **Cron controls** | D | Pause, resume and run-now through `/api/agents/[id]/control`. Admin-only and audited. |
| 12.5 | **Blocked → human-owned request** | M | `agent_requests` show in the inbox with an owner and a link back to the task, and the task page shows "Waiting on Ana". |
| 12.6 | **Team export / import** | D | Export agents, org, pipelines and schedules. Brain is off by default and customer-scoped notes are never included. A "Not included" list is shown before download. Imports land paused. Round-trip test plus a secret-grep test. |
| 12.7 | **Pinned customers + sample client** | M | Pinned customers show in the sidebar (per user). A "Load sample client" option on an empty company seeds one project, two tasks and one pending approval. |

---

## 6. Do not build

| Item | Why not |
|---|---|
| **CEO / board metaphor, hire approvals as a headline** | Agencies have a human lead and client owners, not an agent CEO. Paperclip's #101 "CEO agent stuck" shows how much complexity the metaphor adds. Keep org data only for escalation. |
| **Racing on adapter count** | Their tracker is dominated by adapter requests and adapter breakage (#187, #1068, #8723, #14093, #4046). Our edge is *one* deeply integrated runtime (Hermes, ~0.2 s gateway) plus OpenClaw/MCP. Each new adapter is a maintenance tax that doesn't strengthen R1–R3. |
| **Plugin system / sidebar plugin slots** | MCP tools are our extension surface. Plugin UI slots make the menu unpredictable, which is the flag-sprawl problem again. |
| **Feature-flagged navigation, two shells** | This is Paperclip's main IA weakness. Ship nav items only when the page exists. |
| **Goal hierarchy (GoalTree)** | The client and the project already answer "why" for our users. It overlaps confusingly with `agent_objectives`. |
| **Skill Studio** | It's a developer tool for prompt authors. Our users pick skills, they don't author them. Revisit if template export creates demand. |
| **Anchored document comments, diff modal** | Low value for agent-delivered work. Brain versions are enough. |
| **Workspaces, worktrees, preview URLs** | Fit only coding agents. That's not our audience. |
| **Conference room / board chat, status cards (beta)** | Our group chats and the dashboard desk already cover this. Their beta flags suggest it's unproven there too. |
| **Run timeline / Gantt page** | Nice to look at but not actionable. The task story plus the Right now card answer the real questions. |
| **Separate "Decisions" page** | It splits attention across two queues. One inbox with an Approvals filter is better, and #4254 suggests users struggle when approvals hide. |
| **Eight liveness labels, watchdog snooze / false-positive** | Too much taxonomy for a phone screen. Start with four outcomes and one stall threshold, then add more only if users ask. |
| **Sidebar lists of live agents and recent tasks** | Our dashboard desk does this with more context. Lists in the sidebar get noisy past a handful of agents (#689 asks for more indicators just to make sense of it). |
