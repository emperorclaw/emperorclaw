# Emperor Claw OS Implementation Instructions

This file explains how the improved Emperor ↔ OpenClaw setup is intended to work and how to implement it cleanly.

## Goal

Create a dedicated Emperor-facing OpenClaw agent that:
- connects to Emperor through a local bridge
- replies in Emperor direct/team threads
- keeps chat isolation from the main OpenClaw session
- can read live Emperor state for common customer/project/task questions
- uses stable bootstrap doctrine from workspace files rather than injecting everything on every turn

## Core architecture

### 1) Emperor is the control plane
Use Emperor as the durable system of record for:
- customers
- projects
- tasks
- resources
- artifacts
- thread state

### 2) OpenClaw is the execution/runtime layer
Use a dedicated local OpenClaw agent as the “brain” for each Emperor-facing persona.
Examples:
- `viktor` for operator chat
- `manager` for oversight/heartbeat/delegation

### 3) Bridge is the adapter
The bridge should:
- authenticate to Emperor
- register runtime/session
- listen on websocket + sync fallback
- route relevant thread messages to the local OpenClaw agent
- extract only human-facing text from OpenClaw JSON output
- send that text back into the Emperor thread

## Recommended install flow

The installer should:
1. Download `control-plane.js` and `bridge.js`
2. Install runtime dependencies like `ws`
3. Bootstrap the companion directory
4. Create a dedicated local OpenClaw agent
5. Overwrite the generic fresh-workspace bootstrap with an Emperor-aware bootstrap pack
6. Write `.env` with restrictive permissions
7. Install a persistent `systemd --user` service
8. Run `doctor`
9. Run a local brain smoke test

## Agent profiles

Support at least two profiles:

### `operator`
Use for human-facing agents like Viktor.

Recommended behavior:
- direct threads auto-reply
- team threads require explicit mention
- no automatic task claiming by default
- explicit task claim only when instructed

### `manager`
Use for oversight agents.

Recommended behavior:
- summarize work health
- detect stale tasks and idle projects
- be less noisy than operator agents
- answer status questions clearly
- do not auto-claim execution tasks by default

## Bootstrap pack

The installer should write these files into the dedicated agent workspace:
- `BOOTSTRAP.md`
- `IDENTITY.md`
- `USER.md`
- `SOUL.md`
- `AGENTS.md` additions
- `HEARTBEAT.md` for manager profile

### Why
The generic OpenClaw first-run bootstrap is wrong for Emperor-facing agents because it causes needless onboarding questions like:
- Who am I?
- What is my name?
- Who are you?

The dedicated Emperor bootstrap should instead teach:
- stable identity
- operator/manager role
- Emperor-as-source-of-truth behavior
- task/thread rules
- concise honest communication

## Thread handling rules

### Operator profile
- direct thread → reply normally
- team thread → require explicit mention

### Manager profile
- direct thread → answer status questions
- team thread → speak when there is real signal (stale work, blockers, useful summary)

## Task handling rules

Do not auto-claim tasks by default unless a real executor path exists.

Safer default:
- let the agent discuss tasks freely
- only claim tasks on explicit instruction

Example explicit triggers:
- “claim a task”
- “take the next task”
- “start working on a task”

## Emperor-aware retrieval

For a pragmatic first implementation, let the bridge fetch live Emperor context for common questions and inject only the relevant summary into the local OpenClaw prompt.

Good first targets:
- customer list
- project list
- task list
- project-specific task scope
- known scoped resources/templates

Do this conditionally, not on every message.

## Long-term direction

Stable doctrine should live in workspace bootstrap files.
Live state should be injected dynamically only when relevant.

That means:
- put role/behavior rules in `.md` files
- keep bridge injection focused on current Emperor state and routing context

## Reply extraction

When calling `openclaw agent --json`, extract only the assistant text from:
- `result.payloads[].text`

Do not send the full JSON envelope back into Emperor chat.

## Multi-agent future

This pattern should support multiple Emperor-facing agents later.
Examples:
- `viktor` → operator
- `manager` → oversight
- `support` → customer support
- `research` → analysis/research

Use dedicated local agents and profile-aware bootstrap for each.

## Operational guidance

Start with:
- one operator agent
- one manager agent later
- explicit task claim only
- lightweight Emperor context injection
- strong separation between stable doctrine and live prompt context

This gives the cleanest path from “chat works” to “real operational workforce behavior.”
