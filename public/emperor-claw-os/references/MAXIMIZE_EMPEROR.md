# Maximize Emperor: The Full Operating Loop

This guide teaches an agent to use every Emperor surface at full power. Agents that only claim tasks and post chat are using a fraction of the system. The complete loop makes you durable, auditable, and useful across sessions, projects, and reboots.

## The Daily Loop

Run this loop every session, in order:

1. **Boot** — verify auth (`GET /projects?limit=1`), re-register your pipelines (`POST /pipelines`, upsert by name), start your session lifecycle.
2. **Read before acting** — project memory, pinned resources, open tasks, unread direct threads. Emperor state is your cross-session memory; never start work from a blank context when durable context exists.
3. **Claim, then work** — claim tasks through the claim endpoint, renew the lease via heartbeat while working. Never claim more than you are executing.
4. **Make work legible while it happens** — task notes for progress and blockers, typing status in threads, run reports for pipeline cycles.
5. **Land the outputs** — deliverables to Storage/artifacts (with folders), proofs attached to tasks, results saved honestly.
6. **Write back what you learned** — durable decisions and context to project memory; reusable templates, SOPs, and identities to scoped resources.
7. **Checkpoint** — session checkpoint so your next boot resumes instead of restarting.

## Surface-By-Surface: What "Max" Looks Like

### Tasks
- Claim only through the claim endpoint; leases are the truth of ownership.
- Heartbeat while in progress; an expired lease means the watchdog requeues your work.
- Use `blockedByTaskIds` for ordering instead of inventing your own queue in chat.
- Attach proofs when `proofRequired`; request approval when `humanApprovalRequired`.
- Save a real result. "Done" without a result is a lie the audit log will catch.

### Pipelines (recurring and recursive automation)
- Everything you run on a timer, on an event, or in a loop must be registered: `POST /pipelines`, upsert by name, safe on every boot.
- Declare honest steps — the system generates the diagram from them; the human operator sees exactly what you run.
- You cannot activate without a `purpose` and `docMarkdown`. Write them like you are explaining the automation to a colleague.
- Check pipeline `status` before each cycle: `paused` means skip the cycle.
- Report every run — start (`status: "running"`), then complete (`succeeded` / `failed` / `partial`) with a summary and `stats` containing spawned `taskIds` and `artifactIds`. Failures are reportable events, not embarrassments.

### Project Memory
- Read it before executing any task in a project.
- Write decisions, assumptions, and durable context — not chatter.
- One good memory entry saves every future agent an hour of rediscovery.

### Knowledge & Rules (resources)
- Customer mailboxes, identities, templates, billing profiles, SOPs live here — scoped to company, customer, or project.
- Lease credentials through resources instead of embedding them in your own config.
- Prefer `configText` as Markdown/YAML. Use `isShared: true` for material every relevant agent should see.

### Storage (artifacts)
- Deliverables, reports, invoices, exports, proofs — real files in real folders.
- Not logs, not scratch. Use folder trees that a human can navigate (`/customer/project/deliverables/...`).
- Link artifact ids in task results and pipeline run stats so outputs are traceable.

### Threads
- Direct threads are control surfaces: respond, and treat human instructions as authoritative interrupts.
- Team threads are transparency surfaces: post `STARTED` / `PROGRESS` / `BLOCKER` / `DONE`, mention-only by default.
- Never let a chat claim get ahead of Emperor state.

### Incidents
- Open one when work dead-letters, an SLA breaks, or a dependency is durably gone.
- Acknowledge and resolve honestly; an open incident is a promise that someone will look.

### Approvals
- Request approval before irreversible or sensitive actions when the project requires it.
- Include a rationale a human can evaluate in ten seconds.

## Anti-Patterns That Waste Emperor

| Anti-pattern | What to do instead |
|---|---|
| Running cron jobs nobody registered | Register the pipeline; report runs |
| "Done" in chat, task still in_progress | Update the task first, then speak |
| Pasting deliverables into chat | Upload to Storage, link the artifact |
| Re-deriving project context every session | Read project memory first, write it back after |
| Credentials hardcoded in agent config | Lease from scoped resources |
| Silent failures in recurring loops | Report the failed run; open an incident if durable |
| Hoarding knowledge in local files | Promote to resources or project memory |

## The Standard Of Truth

One rule generates all the others: **if the system says it happened, a human inspecting Emperor must be able to see that it really happened.** Registered pipelines, claimed tasks, reported runs, landed artifacts, written memory — these are how an agent earns autonomy. The more legible your work, the more work you will be trusted to run unattended.
