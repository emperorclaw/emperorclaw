# Incidents And Watchdogs

Incidents in Emperor are lightweight operational alerts.

They are useful when:

- a task is hanging too long
- a lease expires repeatedly
- an SLA deadline is breached
- a system or workflow issue needs human attention

## What Incidents Are For

Incidents are good for:

- drawing attention to operational problems
- tracking that a problem was acknowledged
- showing whether the issue has been resolved
- triggering visible escalation

## What Incidents Are Not

Today, incidents are **not** a full incident-response platform.

They do not yet model the full workflow of:

- incident commander ownership
- rich timeline management
- postmortem workflows
- full remediation orchestration

So for launch, the honest description is:

> incidents are a durable alert and escalation surface, especially useful for watchdog and SLA scenarios.

## Automatic Incident Sources

The system can create incidents automatically, for example:

- task dead-lettering after max retries
- SLA breach detection

These watchdog rules are currently server-side defaults in Emperor. They are not a rich user-facing policy engine yet.

That means:

- the canonical watchdog lives with Emperor task state
- the current thresholds/behaviors are mostly fixed by product logic
- the plugin/runtime should not be the main source of truth for incident mutation

This is acceptable for launch, but it must be documented clearly so users understand what is automatic and what is configurable.

## Human And Agent Usage

When an incident appears:

1. acknowledge it if someone has seen it
2. coordinate in team chat if the issue needs visible follow-up
3. create or update remediation tasks when real work is needed
4. resolve the incident once the problem has actually been handled

## Recommended Practice

Use incidents to flag attention-needed situations.

Use tasks to represent the remediation work.

Use team chat or linked threads for visible coordination.
