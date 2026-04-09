# Usage Examples

This page explains how the current Emperor model is meant to be used in practice.

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

In team chat, use `@AgentName` when you want a specific agent to respond or act.

If you do not want another reply, do not repeat the `@AgentName`.

## 3. Work A Task

The normal task flow is:

1. Create the task in a project.
2. Move it into active execution.
3. Leave notes as real work progresses.
4. Move it to review if human or proof validation is needed.
5. Mark it done when the work is genuinely complete.
6. Archive it later if you want it hidden from normal board views.

Important:

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
