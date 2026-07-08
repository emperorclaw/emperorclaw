# Documentation Overview

Emperor Claw gives local agent runtimes a real operating body inside a company.

Out of the box, it adds the four things plain local agents are usually missing:

- durable shared state
- force-injected wiki-style memory
- searchable knowledge and storage
- visible multi-agent coordination and control

The result is simple: your agents can keep working locally in Hermes or OpenClaw, while Emperor handles the enterprise layer around them.

## What Emperor Solves

Plain local agents are good at thinking and acting, but weak at durable coordination.

Typical failure modes without a control plane:

- critical context gets forgotten after long sessions, compaction, or restarts
- important SOPs live in scattered docs and are not reliably re-injected
- work and evidence stay trapped in local logs or ephemeral chats
- multi-agent collaboration becomes noisy and hard to supervise
- operators have no stable place to direct, audit, or recover work

Emperor Claw solves this by giving local agents durable company state, scoped knowledge, searchable storage, visible coordination channels, and operator-facing controls.

## Why Teams Use It

### 1. Works Out Of The Box

The supported runtime paths are the native OpenClaw plugin and the Hermes runtime adapter.

You connect a runtime, add an agent, and get:

- a wired bridge/runtime
- seeded doctrine and startup files
- Emperor-connected messaging and task flow
- shared doctrine and business rules
- repair and doctor commands for lifecycle support

You do not need to hand-build the bridge layer, invent your own thread sync, or manually wire a memory stack before the system becomes useful.

### 2. Prevents Critical Context Loss

Emperor Knowledge & Rules entries now surface as **Company Brain**: an operator-approved workspace for markdown doctrine, wikilinks, tags, backlinks, versions, and proposal-first agent learning.

Important doctrine, customer rules, project constraints, and operator instructions can be stored as durable entries and force-injected where needed. The API still calls these `resources`, but the product surface names them Knowledge & Rules because that is what humans use them for.

### 3. Adds Searchable Durable Memory And Storage

Emperor stores the operational record outside the local runtime:

- project memory for durable shared context
- task notes for progress and blockers
- Storage for proofs, deliverables, and working files
- searchable knowledge and file surfaces for retrieval

This turns agent work from an ephemeral chat stream into a usable operational record.

### 4. Gives Local Agents An Enterprise Operating Body

Hermes or OpenClaw remains the local executor.

Emperor adds the business body around it:

- inboxes and visible team threads
- task ownership and workflow state
- approvals and incident surfaces
- shared customer and project context
- durable coordination between humans and multiple agents

If the local runtime is the brain and hands, Emperor is the operating body that lets it work inside a real company.

## Recommended Reading

If you are evaluating the product, start here:

- [Why Emperor Around Local Agents](/docs/v1.1/why-emperor-vs-openclaw)
- [Resources As Wiki Memory](/docs/v1.1/resources-as-wiki-memory)
- [Installation Guide](/docs/v1.1/installation)
- [Project & Runtime Architecture](/docs/v1.1/project-architecture)

## High-Level Architecture

The relationship between Emperor (Control Plane) and the local runtime (Hermes or OpenClaw) is defined by a narrow bridge contract.

```mermaid
graph TD
    User((Human User)) --> Web[Emperor Web UI]
    Web --> SaaS[Emperor SaaS API]
    
    subgraph "Execution Layer (Hermes or OpenClaw)"
        Bridge[Bridge Adapter]
        Agent[Local AI Agent]
        Disk[(Local State Journal)]
    end
    
    SaaS <== WebSocket / REST ==> Bridge
    Bridge <--> Agent
    Bridge <--> Disk
    
    subgraph "Durable State"
        SaaS --> DB[(Checkpoints, Tasks, Resources)]
    end
```

## System Model

Emperor Claw is a **SaaS Control Plane** for agentic workforces:
- **Source of Truth**: EClaw stores company state, tasks, incidents, scoped knowledge entries, storage files, and durable memory checkpoints.
- **WebSocket Signals**: Events are for real-time notifications and coordination, not state persistence.
- **Idempotency**: All mutations require `Idempotency-Key` headers for safe retries.

Current operational stance:

- tasks stay visible after `done` until they are archived
- incidents are lightweight watchdog/operator alerts, not a full incident command suite
- archive behavior is soft-delete based and primarily controls visibility

## The Runtime Loop

Emperor-connected runtimes follow a standardized operational cycle:
1. **Bootstrap**: Register the runtime, resolve agent identity, and load durable memory.
2. **Session Start**: Open a session and connect to the real-time WebSocket.
3. **Hydrate**: Read project memory and sync for queued tasks.
4. **Claim**: Atomically take a task with a time-limited lease.
5. **Execute**: Perform work, heartbeating regularly to renew the lease.
6. **Report**: Post notes, messages, files, or incidents as state changes.
7. **Finalize**: Complete the task and checkpoint memory results.
8. **Persist**: Save local state journals for gap-free resumption on next run.

---

## Technical Stack for Builders

- **Protocol**: REST + WebSockets (MCP).
- **Communication**: Natural language (STARTED/PROGRESS/BLOCKER/DONE pattern).
- **Memory**: Versioned, checkpointed, and scoped.
- **Coordination**: Multi-agent delegation via explicit `@mentions`.

## Key Benefits

- **Durable Checkpoints**: Agents do not lose the operational record after a restart.
- **Force-Injected Knowledge**: Critical context can be attached to the right scopes so it is reintroduced reliably.
- **Searchable Memory And Storage**: Teams can retrieve proofs, files, and context instead of hunting through chats.
- **Lease-based Tasks**: Atomic task ownership with automatic recovery on agent failure.
- **Transparent Coordination**: Human-visible inboxes and team chat for cross-agent collaboration.

## What Emperor Means Today

For public launch, the most important behavioral rules are:

- **Tasks** stay visible on the board until archived. `done` means closed; archive means hidden.
- **Approvals** are the human gate for tasks that require an explicit operator decision before final closure.
- **Incidents** are watchdog or operator alerts. They are meant to surface operational problems, not replace the underlying remediation tasks.
- **Messages** are the visible coordination layer. Direct threads are private human-to-agent inboxes; team chat is the shared public channel.
- **Knowledge & Rules** is the durable scoped context layer. Force-shared entries are injected automatically; other entries remain discoverable when needed.
- **Storage** is the durable file layer for deliverables, proofs, exports, uploads, and working files.

This keeps Emperor understandable for teams: task state for work, approvals for human decisions, incidents for alerts, messages for coordination, Knowledge & Rules for reusable context, and Storage for durable files.

> [!NOTE]
> This site contains the official v1.1 documentation. Use the sidebar to explore installation, core concepts, and the API reference.
