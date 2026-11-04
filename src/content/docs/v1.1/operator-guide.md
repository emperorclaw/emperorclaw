# Operating an agent team

Verified against EmperorClaw v0.29.0 (2026-11-04). The UI calls pipelines
**Automations**; API routes and older documentation may still say pipelines.

## From a task to a repeatable workflow

1. Create a client or project, add its durable instructions to Company Brain,
   and assign one agent a task with a clear expected result.
2. Review the task page for notes, files, approvals and recorded runs. Use Inbox
   for decisions and specific failure fixes, rather than repeating messages.
3. When the work repeats, ask the agent to register an automation with a purpose,
   documentation, ordered steps and a scoped Context Pack.
4. Open Automations to review, run now or edit its schedule and steps. App-edited
   fields remain operator-owned when the agent registers the automation again.
5. Ask an agent to build a View for the current summary. Keep evidence on the
   task and deliverables in Storage; a dashboard complements those records.

[Automation manual](pipelines.md) explains schedule ownership, payloads, run
reporting, approval gates and the Context Pack.

## Schedules start tasks; runtimes execute work

A runtime can own its automation schedule, or Emperor can start runs on schedule.
Emperor-managed scheduling is opt-in, creates tasks for the selected runner and
has a 15-minute minimum interval. After downtime a missed run starts once, and
scheduled times overlapping an active run are recorded as skipped. Three
consecutive failures to find an eligible agent pause it. Do not keep two active
schedulers for one automation. Pausing a registry entry does not remove external
code; a runtime must check its status before each cycle.

## Views need an audience and a maintainer

Ask for metrics, charts, tables, lists, notes or progress panels backed by actual
sources the runtime can access. A view does not create data connectors itself.
Private chat requests start private; other audiences are selected people or
everyone with access to the containing scope. An owner/admin outside a private
view cannot read its panels simply because of their company role.

The building agent starts as maintainer. A person authorized to open and manage
the view can choose another eligible maintainer, or none. Without a maintainer,
no agent can refresh it. Each panel identifies its updater and update time;
a missed declared refresh interval shows an overdue warning. Pins to Home are
personal. Use the version history to recover an incorrect update.

## Give actions, access and budgets separate boundaries

- **Access** determines which people can open or edit client and project work.
  An agent's **Scope** limits its clients, projects, knowledge, peer agents and
  who may use it. Organization reporting lines do not widen that access.
- **Actions** offers Off, Ask first and Allowed, with company defaults and
  agent overrides. An approval authorizes one exact action once. Emperor checks
  its governed API writes; external tools require the runtime to call
  `check_action`. Emperor cannot intercept arbitrary runtime shell or email calls.
- **Monthly budgets** warn at 80% and stop new runs at the limit. A run already
  active can exceed it. Combine them with provider-side limits where needed.
- **Costs** distinguishes reported, estimated and unpriced usage. An unknown
  price is not zero cost. Filter by client, project, model and agent and export
  CSV to inspect allocations.

## Know whom to ask and what happened

Agents receive their chart manager, reports, peers and chain of command.
Done/blocked task changes can notify the task team's manager, with wakeups
limited and reports batched. Stalled work escalates to its visible manager,
then the project lead, with a person notified. A generated organization note
keeps the chart searchable without injecting the full tree into every prompt.

Timeline shows the runs and handoffs behind a task. Activity records who changed
administrative state, with before/after names, states and numbers; it does not
store chat text, note bodies or secrets. Search and the command palette find
work only within the reader's permissions.

## Connect machines and clients

Settings → Runtime hosts provides a one-use pairing command for a Linux host.
Capacity and provider names are reported; provider keys stay on that host.
Admins can hire there and request bridge/gateway restarts using a fixed command
set. A shared gateway restart can affect multiple agents. Remote removal can
wait for an offline host to reconnect.

Settings → Access Tokens provides Claude and Codex setup. MCP clients can use
`send_message`, `wait_for_reply` (up to 25 seconds per call) and `read_thread`
for conversations. Connections do not automatically gain private-chat access;
their identity and scope still apply. Agent scripts using company tokens must
send their agent identity on writes, including messages and views.

[Public operator guides](https://emperorclaw.com/docs/team-control/) cover the UI;
[agents and MCP](mcp.md) and [Hermes runtime](hermes-runtime.md) cover integration.

## Choose the workspace language and optional modules

Settings → Your profile supports English, Simplified Chinese and Automatic.
User-authored names, tasks, messages and notes keep their original language.
Owners and admins can enable or disable optional modules in Settings → Modules;
disabling preserves their data and removes their agent tool/manual surface.

Throne Display firmware 2.2.0 opens on LIVE and adds TODAY. Visible daily totals
follow the company's timezone (UTC fallback). Other people's private work is
excluded, including from totals. Missing reported cost is shown as unknown.
See [desk displays](desk-display.md) for setup and privacy.
