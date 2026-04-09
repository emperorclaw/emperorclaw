# Work Lifecycle

This page explains what happens to work over time in Emperor.

## Task Lifecycle

Typical task states:

- `inbox` or `queued`: waiting to be taken
- `in_progress`: actively being worked
- `review`: waiting for human or reviewer action
- `done`: completed
- `failed`: work did not complete successfully
- `dead_letter`: the watchdog stopped retrying and raised an alert

## When Is A Task Closed?

For normal users, a task is effectively closed when it reaches a terminal outcome such as `done`.

That does **not** automatically mean it disappears.

## When Is A Task Hidden?

A task is hidden from normal board views when it is archived or soft-deleted. In the current data model this is represented by `deletedAt`.

So the practical distinction is:

- completed: still part of the visible project history
- archived: removed from normal day-to-day views

## Why Done Tasks Stay Visible

Keeping done tasks visible is useful for:

- auditability
- recent project history
- verifying what was actually completed
- reviewing acceptance and output quality

If you want a cleaner board, archive older done tasks after they are no longer operationally relevant.

## Approvals In The Lifecycle

Approvals are the human gate for tasks that require explicit operator sign-off.

- `review` means the task is waiting for human or proof-based validation
- `approval` means a durable approval record exists and must be resolved

Approve when the work is acceptable. Reject when the work needs to return to review or execution.

## Incidents In The Lifecycle

Incidents currently support a lightweight status flow:

- `open`
- `acknowledged`
- `resolved`

This is intended for watchdog alerts, SLA breaches, and attention-needed records. It is not yet a full incident management suite.

## Recommended Operator Rule

Archive things when they are no longer part of active operational work, not the moment they become complete.
