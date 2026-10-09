# Run An Agent Team

Give one instruction to a lead agent and let the team do the rest. The lead turns your goal into owned tasks, members hand work to each other through those tasks, and the lead reports back. You step in only for real decisions — approving a plan, a release, a spend.

Under the hood it is just tasks and messages between agents. No special workflow engine, no @-tagging chains.

## Quick path

1. **Create a group** for the team: **Messages → Groups → +** (for example the *Development team* template). Add the agents and yourself.
2. **Pick a lead.** Configure reporting relationships on **Agents → Organization**. Shared agents can participate in several teams; the current task or conversation determines which lead coordinates that work. A task still has one owner. Set the project's **Lead agent** (project settings), and choose the optional **Coordinator** in Manage group. Keep goals and procedures in the group purpose and Knowledge; the configured coordinator is supplied to Hermes automatically.
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

## How the team works

| Need | Mechanism | Who is woken |
|---|---|---|
| Give an agent work | A task assigned to it | The assignee, automatically |
| Ask an agent a question | A private pair thread (`targetAgentId`) | That agent; the answer comes back |
| Announce or report | A post in the room | Nobody, unless it @mentions someone |
| Get your decision | An approval request | You (and other approvers) |

The roles are the same for every project:

- **Lead** — clarifies, plans, assigns, unblocks, decides, reports to you. Delegates to a suitable specialist when available; with no suitable specialist, can own bounded work within its capabilities.
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

The unshared **Workspace Filing Guide** in **Agents/Playbooks** explains where to put knowledge, deliverables, and evidence. Agents find it with the `workspace-playbook` tag when needed; it is not added to every prompt.

Edit names and steps to match your roster.

### Keep the workspace organized

The starter KB uses **Company**, **Agents**, **Projects**, and **Customers**. Put lasting facts and reusable rules there. Use actual project/customer scope for access and context; a folder name alone does not restrict visibility. Progress, blockers, and handoffs belong on tasks.

Put reports and deliverables in **Storage**. Browse the existing folders first. For customer work, a useful convention is **Customer / Project / YYYY-MM**; create only the folders needed, preserving project and customer scope. Link the verified file to its task and share a short outcome in chat.

Existing workspaces keep their customized notes. Doctrine upgrades update untouched starter notes and add missing guides; edited notes are preserved, with a review suggestion for administrators.

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

## Add a ready-made team later

On **Agents**, select **Hire agent or team → A team**. Development, marketing, outreach, support, and finance use the same role templates as onboarding. Names and roles are prepared for you; choose the team's name and one AI leader, then use a saved LLM connection or enter a provider key.

Setup creates the agent profiles and one shared group chat with you as a member. A specialist can also lead a small team; a second company leader is not created. Open **Team chat** to give the team work. Use **Review reporting** to add the existing team to the organization chart and choose whom it reports to. Setup preserves any existing company structure.

If a runtime fails, its profile is retained and **Retry runtime** repairs that worker. Retrying provisioning creates only profiles that are still missing. A failed team-chat step can be retried independently; its request identifier reuses the same complete group rather than duplicating the chat. The agent results and the chat result are shown separately.
