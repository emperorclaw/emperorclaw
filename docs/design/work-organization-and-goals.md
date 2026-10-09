# Work organization and persistent objectives

## Organization

A work team is an existing group conversation. Its optional coordinator can be a human or agent; membership is many-to-many. Coordination describes responsibility, not authorization. Project lead and approval rules remain authoritative. Avoid an exclusive department tree: it would misrepresent shared agents and break existing onboarding.

The dashboard uses team branches with their coordinator and members. Arrange teams exposes an agent palette: drag onto a team, or select and press Add here (keyboard and touch alternative). Adding never removes another membership. Coordinators are selected from actual members; existing human coordinators remain selectable. Full human membership management stays in the existing group editor. No new database table or migration is needed for this layer.

Group turns receive current-room purpose, bounded member names, coordinator and concise delegation rules. Direct turns receive a summary of at most four of the agent’s own teams and its role, under 900 characters, with complete membership available through existing tools. The complete membership is available through existing group tools. Do not inject the entire organization into every turn. Runtime access and message routing continue to enforce actual membership, not the text prompt.

## Portable objectives (default)

Objectives are Emperor-owned and provider-independent. Emperor keeps the objective, sends the agent an ordinary private prompt on a fixed cadence, and the agent reports status with an authenticated tool. This replaced the Hermes-native goal engine as the default so every runtime that can receive and send messages can run an objective — no runtime-side goal manager, no provider-specific adapter.

How it works:

- Start in the agent's private conversation: `/goal <objective>` or the Objective control in the agent dialog. The row stores the agent, the creating person, and the originating direct thread; every followup is posted back into that same thread.
- A background sweep (the lifecycle monitor) posts one normal queued prompt per cadence, then advances `nextRunAt`. It is guarded by a transaction-scoped advisory lock (concurrent servers skip), so a multi-instance or multi-tick deployment never double-posts.
- No overlap: while a prompt for the objective is queued, seen or acting, the sweep pushes the next run out instead of stacking prompts on a busy agent.
- Finite budget: `maxFollowups` (default 20, capped at 100) caps a runaway objective; at the limit the objective pauses with a "followup budget reached" reason and stops sending.
- Serialized mutations: start, pause, resume, block, complete and cancel run under the agent row lock, so two concurrent starts leave exactly one live objective and a pause/stop racing the sweep can never be followed by a stale prompt.
- Stopping cancels queued prompts: pause, block, complete and cancel mark any still-queued objective prompt as cancelled, so a stopped objective cannot wake the agent later.

Agent reporting (authenticated, ownership enforced):

- MCP tool `update_objective` and `list_objectives`, or `POST /api/mcp/objectives` (GET lists). The token is bound to one agent, so an agent can only read or change its own objective; the service re-checks company + agent ownership. `update` reports progress, `block` requires a `blockerReason` and pauses check-ins, `resume` restarts them, `complete` records a `completionSummary`, `pause`/`cancel` stop them.
- Tool-less fallback for runtimes that expose no Emperor tools (for example the Codex bridge, which only sends chat text). The objective prompt also teaches one optional isolated line: `EMPEROR_OBJECTIVE_STATUS {"objectiveId":"…","action":"complete", …}`. The server strips the marker line from any agent reply **before** it is persisted, mirrored to the legacy chat, or broadcast, so it is never visible text in the transcript or on the live stream. An authorized marker — an authenticated agent reply that answers that agent's own objective prompt in the same company and thread, with a matching `objectiveId` — is kept in server-only message metadata and applied after the send. Unauthorized or malformed markers are stripped but never applied; a caller-supplied control key is discarded and only the server's own derivation is trusted. Because sanitizing lives in the shared `appendThreadMessage` path, both MCP reply entrypoints (`/messages/send` and `/threads/:id/messages`) behave identically and every provider's normal replies can drive an objective.

Privacy:

- The objective belongs to the person who started it and to the agent. Only that person (and company owners/admins) can read its text or manage it; other members see a redacted status ("Managed in another private conversation."). This preserves the privacy the native goal UI had.

UI: one optional Objective control in the agent dialog — objective text, a check-in cadence (15 min / 1 h / 4 h / daily), Start, and Pause / Resume / Stop for a live objective. No turn-limit or other runtime-specific configuration.

Safe cadence: bounded to 5 minutes – 7 days, default 60 minutes, so an objective cannot be made to hot-loop the agent.

Backwards compatibility: old Hermes-native goal records and commands still work. `threadMessages` rows carrying `runtimeGoalRequest` remain readable by `/api/mcp/agents/goals`, and `/kill` / `/replace` still cancel them. New objectives never write those records.

## Blocked tasks

A task can be set to `blocked` with a required reason (top-level `blockedReason`, also accepted inside `inputJson`). The blocked state is deliberately excluded from the stall sweep and the daily review, so a task waiting on a person or an external event is never nagged. It stays visible on the board in its own Blocked column and in the task overview. Unblocking (back to `in_progress`, `inbox` or `review`) clears the reason and bumps `updatedAt`, which restarts the progress clock so the task is not immediately stale again. The web UI collects the reason in an accessible in-app dialog for both the state selector and drag-and-drop (no native browser prompt); agents set it through `update_task` with `state: "blocked"` and `blockedReason`.

## Peer messaging: team first

When an agent messages another agent by `targetAgentId` with no explicit `threadId` and no `replyToMessageId`, Emperor now prefers the work team they share over a private pair thread:

- It finds the group chats both agents belong to, excluding private pair threads and archived/inactive groups. Exactly one shared team is used directly.
- When several are shared, only a uniquely identified organization work team (`companies.organizationJson.teamIds`) is chosen; otherwise the send is refused with a message asking for a `threadId` or `private: true`. An arbitrary team is never picked.
- With no shared team, the existing private two-agent pair thread is retained as the safe fallback.

The recipient is addressed by an `@Name` mention in the team message, so the routing verdict is `mention` for them and `not_addressed` for every other member — only the intended agent is woken, and loop guards/membership still apply. Agents may belong to multiple teams; ambiguity is surfaced, never guessed.

Explicit context always wins: a `threadId` or `replyToMessageId` pins the message to that thread (an explicit pair reply stays in the pair). `private: true` on `send_message` / `emperor_send_message` / `/api/mcp/messages/send` forces the private pair and is fully backward compatible (the flag is optional; existing calls keep working). Team membership is still enforced on both sides: posting to a group the sender does not belong to is denied, and naming a `targetAgentId` who is not a member of an explicit group thread is denied too (a handoff is never addressed to someone outside the room).

## Organization management

The chart has one company leader, human or AI. Each team has its own dedicated AI leader; leaders cannot be shared as teammates on other chart branches. Ordinary specialists can belong to several teams. Existing group chats keep their participants and history; a company leader can observe a team chat without reporting to its team leader. The chart determines reporting, not chat membership. Legacy configurations remain readable.

Click a team to edit its name and purpose, change its AI leader, add teammates, or open its chat. Removing a branch only removes the chart relationship. Archiving a team removes its chart branch and hides its chat from active lists in one transaction; agents, participants, and past messages are retained.

Settings switches to a grouped section selector when its available content width is below 900px. Desktop section headings use uppercase labels and dividers. Organization dialogs follow the selected color theme. Completed task cards expose Archive task with a confirmation dialog; archived tasks leave the board while retaining history and files.
