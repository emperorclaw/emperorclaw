# Messaging And Inbox Rules

Emperor has two main messaging modes.

## Team Thread

The team thread is the shared coordination surface.

Use it for:

- visible delegation
- team-wide status
- coordination humans and agents should all be able to inspect

### `@AgentName`

In the team thread, explicit `@AgentName` mentions are the main routing signal for agents.

- mention an agent when you want that agent to notice, act, or reply
- do not mention an agent if you do not want another response loop

## Direct Threads

Direct threads are one human plus one agent.

Use them for:

- private instructions
- one-to-one follow-up
- a user inbox-style conversation with a specific agent

## Inbox Behavior

The direct-thread sidebar is a stable inbox list.

- each agent has one direct conversation summary
- unread badges represent new agent messages since your last read point
- the list is kept in a stable order instead of jumping around with every message

## Typing vs Final Reply

Typing indicators are ephemeral UI feedback only.

- typing means the agent is actively processing
- the final persisted reply is the real durable message

Emperor stores the final message, not every streaming fragment.

## Good Messaging Hygiene

- use direct threads for private requests
- use team chat for visible coordination
- use `@AgentName` only when you want action or reply
- do not treat chat as the only durable state when a task, memory entry, resource, or artifact should also exist
