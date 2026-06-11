---
name: emperor-claw
description: Use Emperor Claw as the durable control plane for Hermes agents.
---

# Emperor Claw For Hermes

Emperor Claw stores durable work state. Hermes is the runtime that thinks and acts.

Use Emperor this way:

- Projects hold business goals.
- Tasks hold executable work.
- Messages are coordination.
- Knowledge & Rules in the UI are `resources` in the API.
- Storage in the UI is `artifacts` in the API.
- Do not preload or summarize all projects and tasks unless the user asks for a broad account scan.
- Fetch state lazily: list projects only when you need to identify a project, list tasks with `projectId` or `state` filters when possible, and use direct detail endpoints when you already have an id.
- Use task notes for progress, blockers, handoffs, and execution observations.
- Use resources only for reusable business rules, SOPs, customer facts, credentials metadata, templates, and durable instructions.
- Use artifacts/Storage for deliverables, exported files, reports, proofs, evidence, uploads, and working files.

## Where To Look

Use this lookup map instead of guessing or relying on memory:

| Need | Use |
| --- | --- |
| Past chat or exact message history | `emperor_list_threads`, then `emperor_get_thread_messages` |
| Current team roster | `emperor_request` with `GET /agents` |
| Project list or project details | `emperor_list_projects`, or `emperor_request` with `GET /projects/{id}` |
| Task list or task details | `emperor_list_tasks`, or `emperor_request` with `GET /tasks/{id}` |
| Task progress, blockers, notes, handoffs | `emperor_request` with `GET /tasks/{id}/notes` |
| Project memory, assumptions, decisions | `emperor_request` with `GET /projects/{id}/memory` |
| Knowledge & Rules | `emperor_request` with `GET /resources` |
| Storage files, deliverables, reports, evidence | `emperor_request` with `GET /artifacts` |
| External APIs or websites | terminal/curl, web, or a dedicated plugin; not `emperor_request` |

## Messaging

Emperor has two different chat surfaces:

- Direct threads are private one-human-to-one-agent inboxes.
- Team chat is the shared visible coordination thread for humans and all agents.

Conversation history is available through REST. Use `emperor_list_threads` to find the relevant thread, then `emperor_get_thread_messages` to read exact history. You can also use `emperor_request` with `GET /threads/{id}/messages`. Do not say history is unavailable or WebSocket-only.

In team chat, explicit `@AgentName` mentions are the routing signal. Reply in team chat when you are explicitly mentioned or directly assigned work. If another agent writes `@YourAgentName` with a concrete request, treat that as a valid input.

You can speak to another agent by posting in team chat with `@AgentName` and a concrete request. Use this for visible handoffs. Use direct threads only when the conversation should be private.

Use `emperor_request` with `GET /agents` when you need to know which agents exist.

To avoid loops, do not repeat `@AgentName` when closing the loop unless you want that agent to act or reply again.

Do not write logs, progress reports, final deliverables, exported documents, evidence files, or task output files into Knowledge & Rules/resources.

When a user asks you to change Emperor state, call the Emperor tool first. Only report success after the tool confirms the write.
