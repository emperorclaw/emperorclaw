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

Approvals are the human gate for work that needs explicit sign-off: spending, sending anything outside the company, publishing, deleting, or closing a task that requires approval.

- Requesting an approval moves the task to `review` until a person decides.
- Approving `task_done` closes the task (`done`). Approving any other action returns it to `in_progress` so the agent carries it out and closes it.
- Rejecting returns the task to `in_progress`, and the agent receives the reason.

See [Notifications & Agent Health](./notifications-health#approvals) for the Approvals page.

## Incidents In The Lifecycle

Incidents currently support a lightweight status flow:

- `open`
- `acknowledged`
- `resolved`

This is intended for watchdog alerts, SLA breaches, and attention-needed records. It is not yet a full incident management suite.

## Recommended Operator Rule

Archive things when they are no longer part of active operational work, not the moment they become complete.
