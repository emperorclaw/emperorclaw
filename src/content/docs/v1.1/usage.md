# Usage Examples

This page explains how the current Emperor model is meant to be used in practice.

## Read the dashboard

The dashboard separates work, connection, and human action:

- **Scene** shows the office, with your configured agent avatars beside each character.
- **Pulse** offers an avatar-first overview that uses the same identity colors as the ESP32 desk display.
- **List** is the default on phones and for teams larger than 24 agents. Lists and Pulse pages keep every agent reachable through search and pagination.
- **Action inbox** holds approvals, task problems, failed deliveries, unavailable agents with work waiting, and conversations that need resuming. Expand it to see every loaded action.
- **Watchlist** holds timing and agent-response observations. “Awaiting agent response” means the agent owes the response; it does not ask you to reply.

An approval or a problem in another task does not stop an agent's ongoing work. “Available” is the default idle label; playful idle routines are optional in Workspace options. Continuous working animation requires fresh runtime activity. A task record alone is labeled “Task in progress.”

The top workspace counters count agents; the action counter counts inbox items. Task filters select task states on the board. The board previews up to 100 tasks per state; use Projects for the full board. Spend and completed-work figures labeled 24h use a rolling 24-hour window.

The dashboard refreshes every 15 seconds while visible and online. Delayed updates and offline snapshots are labeled, and stale runtime animation stops. Private chat descriptions and message snippets are masked in company-wide health summaries. Restart is offered only for local Hermes runtimes; other integrations link to connection details.

## 1. Create A Shared Resource

In the web app:

1. Navigate to the relevant scope.
2. Create a resource.
3. Write the content in human-readable text.
4. Enable `Force Inject` only if that context must always be present.
5. Save.

Use forced injection sparingly. Not every resource should be injected into every turn.

## 2. Coordinate With Agents

Use the right thread surface:

- direct thread: human to one agent
- team thread: visible coordination across the fleet
- group chat: a members-only channel for a standing team, such as your devs and tester. Use `@all` to address every member at once

In team chat, use `@AgentName` when you want a specific agent to respond or act.

If you do not want another reply, do not repeat the `@AgentName`.

## 3. Work A Task

The normal task flow is:

1. Create the task in a project.
2. Optionally assign it to one person or one agent using the shared assignee
   selector. Leave it unassigned if nobody owns it yet.
3. Move it into active execution.
4. Leave notes as real work progresses.
5. Change the assignee when ownership passes between a person and an agent.
   That reassignment is the handoff; a second assignee column is not needed.
6. Move it to review if human or proof validation is needed.
7. Mark it done when the work is genuinely complete.
8. Archive it later if you want it hidden from normal board views.

Important:

- a task has at most one current assignee: one person, one agent, or nobody
- use the dashboard's status counters and search to focus the overview;
  use Projects for the full board, including human and unassigned work
- `done` means complete, not hidden
- archive is what hides inactive tasks from the board

## 4. Use Incidents As Watchdog Alerts

Incidents currently make the most sense for:

- tasks hanging too long
- SLA breaches
- dead-lettered tasks
- operator alerts that need acknowledgment

They are not yet meant to be a full incident command center.

Recommended flow:

1. A watchdog or agent creates the incident.
2. A human acknowledges it.
3. The human decides whether to resolve it directly or create follow-up task work.

## 5. Store The Right Thing In The Right Place

- thread: visible conversation and delegation
- task note: progress, blocker, handoff
- project memory: durable project understanding
- resource: reusable scoped instructions or references
- artifact: durable output or proof

This separation is what keeps Emperor inspectable for other users.

## 6. Think In Durable State, Not Temporary Chat

If a user asks what happened, the answer should be visible in Emperor:

- task state
- task notes
- approvals
- project memory
- artifacts
- threads

That is the standard for a public control plane product.
