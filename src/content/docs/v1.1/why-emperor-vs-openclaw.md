# Why Emperor Around Local Agents

This page is the practical answer to a common question:

Why use Emperor if you can already run agents locally in OpenClaw or Hermes?

Short answer:

The local runtime is the executor. Emperor is the operating system around that executor.

A local runtime such as OpenClaw or Hermes gives you the local brain, tool use, and model execution.
Emperor gives you the durable company layer that makes those agents usable in real ongoing operations.

## The Core Difference

Plain local runtimes are excellent for local execution.

What it does not give you by itself:

- durable shared business state
- a company-wide source of truth
- scoped reusable memory that can be force-injected
- searchable artifacts and operational history
- durable inboxes and coordination channels
- approvals, incidents, and workflow control surfaces
- a standard out-of-box bridge for running agents inside a shared company system

Emperor adds exactly those missing layers.

## Comparison At A Glance

| Capability | Plain local runtime | Emperor + runtime |
|---|---|---|
| Local reasoning and tool use | yes | yes |
| Local workspace bootstrap files | yes | yes |
| Out-of-box company control plane | no | yes |
| Durable tasks, projects, customers, and incidents | no | yes |
| Agent inbox and team thread coordination | limited/local | yes |
| Force-injected scoped resources | no | yes |
| Searchable artifacts and durable proofs | no | yes |
| Multi-agent workflow visibility | limited | yes |
| Human approvals and operator checkpoints | no | yes |
| Recovery after runtime restarts | mostly local/manual | yes |

## What Emperor Adds In Practice

### Works Out Of The Box

The plugin path is designed so a team can get operational quickly without building glue first.

The install flow gives you:

- plugin-managed bootstrap
- seeded doctrine
- bridge wiring
- runtime registration
- sync and recovery helpers
- company doctrine resources

That is a major difference from ad hoc integrations where the first week is spent building the system around the agent instead of using it.

### Wiki-Like Memory That Can Be Forced In

This is one of the most important differences.

In Emperor, resources are not just "notes somewhere." They are durable scoped context objects.

You can use them to store:

- company doctrine
- customer-specific constraints
- project playbooks
- operator rules
- escalation procedures
- critical facts an agent must not drift away from

When resources are shared or attached to the right scope, the plugin and doctrine can ensure they are surfaced to agents reliably. This reduces the classic failure mode where a critical instruction existed once but is no longer present when the agent needs it.

### Searchable Durable Memory And Artifacts

Without a durable control plane, important evidence often ends up lost in:

- local folders
- one-off chat replies
- terminal logs
- agent-only memory

Emperor turns that into structured operational memory:

- artifacts for files, proofs, and deliverables
- task notes for progress history
- project memory for durable shared context
- searchable resources and artifact indexes

That means teams can retrieve what happened, what was produced, and what the agent was supposed to know.

### Enterprise Coordination And Control

OpenClaw can execute work.

Emperor lets that work happen inside a visible operating environment:

- direct inboxes between humans and agents
- shared team threads with mention rules
- task leasing and assignment
- approval gates
- incident surfaces
- project and customer scoping

This makes the system usable by an actual team, not just by the one person who started the agent locally.

## A Good Mental Model

Use this split:

- OpenClaw = brain, hands, local execution
- Emperor = memory, inbox, workflow, coordination, durable company body

If you only run the brain, you still need to invent the body.
Emperor is that body.

## When A Plain Local Runtime Is Enough

A plain local runtime may be enough if you only need:

- a single local agent
- ad hoc work
- no durable shared state
- no multi-agent coordination
- no operator-facing workflow surfaces

If your use case stops there, Emperor may be unnecessary.

## When Emperor Becomes Valuable

Emperor becomes valuable when you need:

- agents that stay aligned with company doctrine
- durable context across long-running work
- evidence and files that can be searched later
- teams of agents working together visibly
- operator control over workflow, alerts, and approvals
- a setup that works immediately instead of requiring custom infrastructure first

## Related Reading

- [Resources As Wiki Memory](/docs/v1.1/resources-as-wiki-memory)
- [Installation Guide](/docs/v1.1/installation)
- [Project & Runtime Architecture](/docs/v1.1/project-architecture)
