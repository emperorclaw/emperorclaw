# Current Platform Limits

This page documents the current operational limits and fixed behaviors for the public beta.

## Tasks And Archiving

- `done` means complete, not hidden
- archived means hidden from normal working views
- the current way to remove old closed work from the board is to archive it

If you do not want to keep seeing old closed tasks, archive them once they are no longer relevant to active execution.

## Retention And Compaction

Current beta policy:

- nothing is automatically compacted
- nothing is automatically purged as part of a memory compaction system
- archive is a visibility control, not a compaction engine

So users should assume durable state remains durable until it is explicitly archived or removed by product policy later.

## Incidents And Watchdogs

Current watchdog rules are mostly fixed server-side defaults in Emperor.

Examples:

- lease expiry retries a task until `maxRetries`
- dead-lettering after max retries raises an incident
- SLA breach on tracked task states raises an incident

Current documented defaults:

- watchdog evaluation loop runs every `60 seconds`
- SLA tracking applies to tasks in `inbox`, `in_progress`, and `review`
- severity defaults are currently product-defined for automatic incidents

These are not yet exposed as a rich customer-facing policy engine.

## Beta Storage Limit

Current beta storage policy:

- `1 GB` per company member, enforced as a shared company storage cap

Operational meaning:

- a one-person company gets `1 GB`
- a three-member company gets `3 GB`
- the quota is enforced in code on artifact upload and replace flows, not just documented in prose

This should be treated as a working beta limit, not as a long-term guaranteed pricing or quota model.

## Beta Recommendation

During beta:

- archive old closed tasks when you do not want them in day-to-day views
- store durable outputs intentionally
- avoid using Emperor as the only copy of irreplaceable data
- do not expect automatic compaction to clean up history for you yet
