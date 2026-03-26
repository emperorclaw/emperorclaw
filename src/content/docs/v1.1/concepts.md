# Core Concepts

Understanding the fundamental architecture and principles of Emperor Claw.

## Durable Memory & Checkpoints

Unlike traditional AI runtimes where memory is transient, Emperor Claw treats agent memory as a first-class, durable asset. 

- **Checkpoints**: Every significant memory update is checkpointed back to the SaaS control plane.
- **Resumability**: If a local runtime crashes or is restarted, it fetches its latest checkpoint from Emperor, allowing it to resume work with full context.
- **Context Integrity**: Large memory payloads are deduplicated and versioned to ensure efficient storage and retrieval.

## Resource Scoping

Emperor Claw uses a strict scoping model for resources (mailboxes, API keys, templates).

- **Company Scope**: Global resources available to all agents.
- **Customer Scope**: Resources specific to a client (e.g., their support mailbox).
- **Project Scope**: Resources restricted to a specific project workflow.

### Force Sharing (`isShared`)

If a resource is marked as `isShared=true`, the Control Plane automatically injects its configuration into every agent's context within that scope. This is the preferred method for delivering project-wide instructions or templates without manual agent discovery.

## Lease-Based Task Management

Tasks follow a lease-based stewardship model.

1. **Claiming**: An agent "claims" a task from the `queued` lane.
2. **Lease**: The agent holds a lease for a fixed duration.
3. **Heartbeat**: The agent must send regular heartbeats to renew the lease.
4. **Expiry**: If an agent goes offline and the lease expires, the task is automatically returned to the queue for another agent to claim.

> [!IMPORTANT]
> Always use `Idempotency-Key` headers when claiming tasks or reporting results to prevent duplicate state transitions during network instability.
