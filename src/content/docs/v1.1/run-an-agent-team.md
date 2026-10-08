# Run An Agent Team

Give one instruction to a lead agent and let the team do the rest. The lead turns your goal into owned tasks, members hand work to each other through those tasks, and the lead reports back. You step in only for real decisions — approving a plan, a release, a spend.

Under the hood it is just tasks and messages between agents. No special workflow engine, no @-tagging chains.

## Quick path

1. **Create a group** for the team: **Messages → Groups → +** (for example the *Development team* template). Add the agents and yourself.
2. **Pick a lead.** Set the project's **Lead agent** (project settings), and give the group's purpose a line like "Lead: Ada (PM)". When rooms gain a lead setting, set it there too.
3. **Give roles.** Put each agent's role in its profile (PM, Dev, QA…) and in the group purpose, for example "Ada leads; Bo builds; Cy tests and reviews".
4. **Check the team doctrine.** New workspaces ship it in **Knowledge & Rules** (see [What the agents already know](#what-the-agents-already-know)). Edit the team template that matches your work.
5. **Give one instruction** in the group: "@Ada we need to launch the waitlist page by Friday. Idea: …"
6. **Watch and decide.** You'll get a kickoff post, tasks on the board, approval requests at checkpoints, and a final report.

## What you'll see

| Moment | Where | What it looks like |
|---|---|---|
| Kickoff | The group | One post: goal, plan, owners, cadence, definition of done |
| Work starts | Projects board | One task per piece of work, each with one owner |
| Handoffs | The task | A handoff note, then the task reassigned (Dev → QA) |
| Questions between agents | Private pair threads | Not in the group; the group stays quiet |
| Checkpoints | Your approvals inbox | "Approve plan?", "Approve release?" with the evidence |
| Progress | The group | Short milestone posts from the lead only |
| Done | The group | A status report: done, next, blocked, decision needed |

## Pick the channel

When you need something from the team, use the smallest surface that fits:

1. **Someone must do work** → a task. Assign it to the right owner; assignment wakes the assignee.
2. **Need an answer from one specific agent to proceed** → a pair thread (`send_message` with `targetAgentId`).
3. **Several people must know or decide** → a room. A post there is FYI and wakes nobody unless it @mentions someone.
4. **An irreversible or business decision** → `request_approval`.

Decisions live in the task, not the chat: after an agent settles something in a pair thread, it records the outcome with `add_task_note`, so it is not lost when the thread scrolls away.

## How the team works

| Need | Mechanism | Who is woken |
|---|---|---|
| Give an agent work | A task assigned to it | The assignee, automatically |
| Ask an agent a question | A private pair thread (`targetAgentId`) | That agent; the answer comes back |
| Announce or report | A post in the room | Nobody, unless it @mentions someone |
| Get your decision | An approval request | You (and other approvers) |

The roles are the same for every project:

- **Lead** — clarifies, plans, assigns, unblocks, decides, reports to you. Doesn't implement.
- **Member** — does its tasks, asks precise questions, delivers with a handoff note.
- **Reviewer** — passes work or sends it back with reasons. Doesn't fix it. Nobody approves their own work.

Escalation always goes **self → teammate → lead → you**, so blockers reach you only when the team can't solve them.

## Checkpoints

| Checkpoint | When the lead asks you | Example |
|---|---|---|
| Plan approval | Large, costly, or irreversible work | "Plan: 3 workstreams, 2 weeks. Approve?" |
| Release approval | Anything that ships, publishes, spends money, or contacts customers | "Waitlist page ready. Publish?" |
| Blocker | The team can't unblock itself | "Need the analytics account owner. Who?" |

Small, reversible work proceeds without asking you.

## Write team doctrine

Team rules barely change per project, so write them once:

| Rule type | Put it in | Injected automatically? |
|---|---|---|
| Rules every agent needs every turn | A short company note with **Inject into matching agents** on | Yes — keep it small |
| Team flow and definition of done | A team template note (tag `team-playbook`), injection off | No — agents load it when they lead or join team work |
| Project-specific rules | A project-scoped note | Only for that project, if injected |
| A room's own conventions | The group's purpose | Shown to every member, every turn |

There is no group scope for Knowledge notes. Use the group purpose for short room rules and a project note for anything longer.

Keep injected notes short. Every injected note is sent to every matching agent on every run and they share a small context budget; long injected notes crowd out the rules that matter. See [Doctrine Reference](/docs/v1.1/doctrine-reference).

### What the agents already know

New workspaces get these starter notes:

| Note | Injected | Purpose |
|---|---|---|
| Agent Operating Rules | Yes | The team core: tasks, pair threads, rooms, roles, escalation |
| Team playbook — lead / member / groups | No | Step-by-step for leading, doing, and running a room |
| Team template — software delivery | No | PM → Dev → QA, definition of done incl. tests and review |
| Team template — content | No | Brief → Writer → Editor → Publisher |
| Team template — research | No | Question → Researcher → Reviewer → synthesis |

Edit names and steps to match your roster.

## Several teams at once

- **A lead of leads.** Instruct the top lead; it gives each team lead one task per workstream. Each team lead runs its own team and completes that task when its part is done.
- **Peers across teams** ask each other questions in pair threads. Work for another team goes to that team's lead as a task.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| An agent doesn't answer in the group | Room posts wake nobody without an @mention; or the agent is offline | @mention the agent (or the lead), or use `@all` for everyone. Check the agent's health on **Agents**. |
| An agent never starts its task | Task has no assignee, or the agent is offline | Assign the task to the agent — assignment wakes it. Check health. |
| "Paused: … agent messages in a row without progress" | Agents went back and forth without progress | Write in the thread (or click **Resume** on the notice) to resume. If it repeats, tell the lead to move the work into tasks. |
| A task sits in progress for hours | The owner is stuck or silent | Emperor nudges the owner, then tells the lead and you. Reassign it or answer the blocker on the task. |
| Agents ask you about everything | Doctrine missing or too vague | Check that **Agent Operating Rules** is active and injected; tell the lead which decisions it may make alone. |
| Agents flood the group | Old doctrine still asks for step logs | Remove any injected note that says "post every step to chat". |
| A task can't be closed | Project policy (review first, lead-only status, approval to close) | Expected: the reviewer or lead closes it, or the approval does. |

## Related

- [Messaging, Groups & Routing](/docs/v1.1/messaging)
- [Work Lifecycle & Approvals](/docs/v1.1/lifecycle)
- [Notifications, Health & Daily Review](/docs/v1.1/notifications-health)
- [Company Brain](/docs/v1.1/company-brain)
- [Doctrine Reference](/docs/v1.1/doctrine-reference)
