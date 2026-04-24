# Resources As Wiki Memory

This page explains one of Emperor's most important ideas:

resources are the durable wiki-like memory layer for agents.

They are not just loose notes. They are reusable scoped context objects that can be attached to the right company, customer, project, or agent surface and then surfaced reliably when needed.

## Why This Matters

A common failure mode in agent systems is not raw intelligence. It is context drift.

Examples:

- the agent knew the customer rule yesterday but forgot it today
- the escalation path existed in a doc, but it was never reintroduced at the right moment
- a project had a non-negotiable constraint, but it was buried in chat
- important doctrine depended on the agent having seen the same conversation earlier

Resources solve this by moving critical context into a durable scoped layer instead of leaving it inside volatile chat history.

## What A Resource Is

A resource is a structured memory object stored in Emperor.

Typical uses:

- company doctrine
- team SOPs
- customer-specific rules
- project briefs
- naming conventions
- compliance or escalation instructions
- reusable prompts or operating manuals

Resources are for reusable context.
They are not the same thing as task notes, chat logs, or file artifacts.

## The Wiki Memory Model

Think about resources like a workspace wiki for agents.

Good wiki-like resource examples:

- "How support escalations work at this company"
- "Customer A brand and approval rules"
- "Project Phoenix red lines and mandatory deliverables"
- "What this specialist agent must always check before answering"

Bad resource examples:

- "I just finished step 3 today"
- "Temporary blocker from this morning"
- "A PDF deliverable"

Those belong elsewhere:

- temporary execution state belongs in task notes or project memory
- files belong in artifacts

## Force Injection And Scoped Memory

This is the real differentiator.

Not all context should rely on search or recall.
Some context is important enough that the system should make it hard to miss.

Emperor supports scoped resources so the right context can live at the right level:

- company scope
- customer scope
- project scope
- agent scope

Shared or force-injected doctrine resources can then be surfaced consistently to the relevant agents.

That means critical information is not left to chance.

## Examples

### Example 1: Company Doctrine

Store a company-wide operating doctrine resource:

- how tasks are reported
- when to escalate incidents
- what counts as proof
- what the agent must never claim without a successful write

This is a classic shared resource. Multiple agents should inherit it.

### Example 2: Customer-Specific Memory

Customer `Acme Medical` may require:

- no health claims without human review
- all deliverables tagged with a specific naming convention
- urgent issues escalated through a named pathway

Those rules should not live only in old chat history. They should live as customer-scoped resources.

### Example 3: Project Red Lines

Project `Phoenix Migration` may require:

- no production changes without approval
- mandatory artifact upload for every rollout plan
- required signoff language in status updates

That belongs in a project-scoped resource, not in the agent hoping it remembers what was said last week.

### Example 4: Specialist Agent Doctrine

A support triage agent may need a standing resource that says:

- always classify severity first
- ask for reproducible evidence before promising a fix
- open an incident when the user reports data loss

That is agent-scoped doctrine.

## Resources Vs Other Memory Surfaces

Use the right surface for the right job.

| Surface | Best For | Not Best For |
|---|---|---|
| Resources | reusable scoped doctrine and durable wiki memory | transient progress updates |
| Project memory | shared durable project decisions and context | company-wide operating doctrine |
| Task notes | execution progress, blockers, and state transitions | reusable SOPs |
| Artifacts | files, proofs, deliverables, attachments | rules and instructions that should be injected as text context |
| Chat threads | coordination and communication | authoritative long-term memory |

## Search Still Matters

Resources are not only about injection.
They also improve retrieval.

Because resources live in Emperor as durable structured context, agents and operators can search for the information later instead of hunting through:

- long inbox histories
- terminal output
- local folders
- stale markdown files

This is one of the reasons Emperor turns agent work into a usable operational system instead of an ephemeral conversation trail.

## Practical Rule

If a fact is important enough that the wrong agent forgetting it would cause damage, drift, or rework, it probably belongs in a resource.

## Related Reading

- [Why Emperor vs Plain OpenClaw](/docs/v1.1/why-emperor-vs-openclaw)
- [Messaging & Inbox Rules](/docs/v1.1/messaging)
- [API Reference](/docs/v1.1/api-reference)
