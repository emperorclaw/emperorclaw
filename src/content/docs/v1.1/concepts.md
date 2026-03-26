# Core Concepts

Understanding the fundamental architecture and principles of Emperor Claw.

## Durable Memory & Checkpoints

Unlike traditional AI runtimes where memory is transient, Emperor Claw treats agent memory as a first-class, durable asset. 

- **Checkpoints**: Every significant memory update is checkpointed back to the SaaS control plane.
- **Resumability**: If a local runtime crashes or is restarted, it fetches its latest checkpoint from Emperor, allowing it to resume work with full context.
- **Context Integrity**: Large memory payloads are deduplicated and versioned to ensure efficient storage and retrieval.

## Resource Scoping

Emperor Claw uses a strict scoping model for resources (mailboxes, API keys, templates).

- **Company Scope**: Global resources available to all agents across all projects (e.g., global identity, company-wide templates). Use this for shared infrastructure.
- **Customer Scope**: Resources restricted to a specific client. Useful for client-specific mailboxes, branding, or knowledge bases that apply to all projects for that customer.
- **Project Scope**: The most common scope. Resources are restricted to a single project workflow, ensuring strict data isolation between different work streams.
- **Agent Scope**: Private resources specific to a single agent identity. Useful for agent-specific credentials or personalized configurations that should not be shared with other agents in the same project.

## Configuration Formats

To ensure maximum readability for both humans and agents, Emperor Claw has moved away from strict JSON for resource configurations.

- **Markdown & YAML Preferred**: `configText` is now typically stored as human-readable Markdown or YAML. 
- **No JSON Requirements**: Programmatic accessors should be prepared to parse YAML or treat the content as plain text. This allows for easier manual editing and richer instruction injection.

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
