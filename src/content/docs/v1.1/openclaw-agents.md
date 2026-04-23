# OpenClaw Agent Runtime

This page explains how Emperor-connected OpenClaw agents actually work in practice.

The short version:

- Emperor is the durable system of record.
- OpenClaw is the local runtime that thinks, reads files, uses tools, writes code, and replies.
- The plugin does not replace the OpenClaw agent model. It seeds and shapes it.

If you need the repo-level architecture and the difference between repo `agents/*`, plugin state, and live OpenClaw workspaces, read:

- [Project & Plugin Architecture](/docs/v1.1/project-architecture)

## What OpenClaw Actually Loads

OpenClaw injects recognized workspace bootstrap files into the agent's prompt context. On the local `2026.3.31` runtime used here, the recognized basenames are:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`
- `MEMORY.md`
- `memory.md`

Important current runtime behaviors:

- normal agent turns can load the full bootstrap file set
- heartbeat turns can be configured to load only `HEARTBEAT.md`
- `AGENTS.md` sections named `Session Startup` and `Red Lines` are re-injected after compaction
- legacy fallback section names `Every Session` and `Safety` still work, but `Session Startup` and `Red Lines` are the current preferred headings
- bootstrap files are subject to prompt-budget limits, so bloated doctrine will be truncated

Practical implication:

- if a rule must survive long-running sessions and compaction, put it in `AGENTS.md` under `## Session Startup` or `## Red Lines`
- if a rule is startup-only, put it in `BOOTSTRAP.md`
- if a rule is persona or tone, put it in `SOUL.md`

## Mental Model

Think of an Emperor-connected OpenClaw agent as three layers:

1. OpenClaw runtime
   - executes the turn
   - reads the workspace bootstrap files
   - uses tools, files, browser, code, and skills

2. Emperor plugin and bridge
   - creates the local agent/workspace
   - seeds doctrine files
   - connects the runtime to Emperor threads, tasks, and durable state

3. Emperor control plane
   - stores customers, projects, tasks, notes, memory, resources, artifacts, threads, and incidents
   - is the truth source for operational state

The plugin should therefore instruct the agent in a way that fits the OpenClaw runtime model instead of fighting it.

## What The Plugin Owns On Disk

The plugin manages more than the workspace files themselves.

For each installed Emperor-connected agent, the plugin also creates:

- a companion directory under `~/.openclaw/emperor-control-plane-<slug>`
- a runtime bridge config and local `.env`
- a bridge state journal used for reconnect and dedupe safety
- a manifest under `~/.openclaw/emperor/agents/*.json`
- thread ownership state under the plugin state root

That manifest tracks the durable local install shape for the agent, including:

- Emperor agent id
- local brain agent id
- runtime id
- companion directory
- service name
- profile
- shared doctrine resource ids
- `threadPolicy`
- `bridgeContract`

Important distinction:

- repo `agents/*` folders are reference role packs
- plugin-generated `~/.openclaw/workspace-<brain-id>` folders are the actual runtime workspaces used by installed agents

## What Each Workspace File Should Do

### `AGENTS.md`

Use `AGENTS.md` for stable operating rules that should remain true across sessions.

Good content for `AGENTS.md`:

- startup obligations
- safety boundaries
- durable operating doctrine
- cross-session rules
- rules that should survive compaction

Bad content for `AGENTS.md`:

- temporary project status
- one-off tasks
- volatile runtime facts
- long narrative background that should live in Emperor resources or project memory

Most important rule:

- put critical Emperor rules under `## Session Startup` and `## Red Lines`

### `SOUL.md`

Use `SOUL.md` for voice, persona, interpersonal behavior, and style.

Good content:

- tone
- how direct or warm the agent should be
- how it should sound in replies
- what kind of personality it should embody

Do not overload `SOUL.md` with operational truth. It is persona, not system state.

### `TOOLS.md`

Use `TOOLS.md` for machine-local operational details:

- local helper scripts
- naming conventions
- machine paths worth remembering
- local infrastructure notes
- practical tool usage hints

Do not put secrets here unless you explicitly want them sitting in prompt-visible workspace text.

### `IDENTITY.md`

Use `IDENTITY.md` for compact self-description:

- agent name
- role
- emoji or avatar hints
- short identity anchors

Keep it short.

### `USER.md`

Use `USER.md` for the operator/human relationship:

- how to address the human
- timezone
- useful preferences
- collaboration expectations

### `BOOTSTRAP.md`

Use `BOOTSTRAP.md` for the per-session startup sequence.

This is where you tell the agent:

- what to read first
- what order to read it in
- what Emperor doctrine files matter
- what assumptions are already configured
- what questions not to ask again

For Emperor-connected agents, `BOOTSTRAP.md` should be treated as persistent launch doctrine, not a disposable first-run file.

### `HEARTBEAT.md`

Use `HEARTBEAT.md` for periodic background review behavior.

Good content:

- short checklists
- stale-task review steps
- inbox or review routines
- when to reply `HEARTBEAT_OK`

Keep it short. Heartbeat turns are frequent and expensive if this file grows without discipline.

### `MEMORY.md`

Use `MEMORY.md` only for truly local long-term memory that belongs in the OpenClaw workspace.

Do not confuse it with Emperor memory:

- Emperor project memory is the durable shared operational record
- local `MEMORY.md` is local working continuity

If the information matters to the team or to durable task truth, prefer Emperor.

## How Emperor Agents Should Be Instructed

The safest pattern is to split instruction responsibilities cleanly.

### Put Here, Not There

- `AGENTS.md`: stable rules, startup obligations, red lines
- `SOUL.md`: personality and tone
- `BOOTSTRAP.md`: exact reading order and startup routine
- `USER.md`: human preferences and collaboration context
- `TOOLS.md`: local machine knowledge
- Emperor resources: reusable scoped doctrine and SOPs
- Emperor project memory: durable project decisions and context
- Emperor task notes: progress and blockers
- Emperor artifacts: deliverables and proofs

### Good Instruction Pattern

```md
## Session Startup

- Read BOOTSTRAP.md before replying.
- Read the relevant Emperor doctrine files named in BOOTSTRAP.md.
- When a task or thread is referenced, prefer Emperor state over guesses.
- In team threads, reply only when explicitly @mentioned unless role doctrine says otherwise.

## Red Lines

- Do not claim a task changed state unless the Emperor write succeeded.
- Do not mark work done without a real result or proof.
- Do not leak agent-scoped or non-shared resource content into team chat.
- Do not delete BOOTSTRAP.md or doctrine files unless the human explicitly asks.
```

### Bad Instruction Pattern

```md
## AGENTS

You are amazing. Always be proactive. Help with everything. Keep track of tasks,
customers, and current priorities here. Current project status: ...
```

Why this is bad:

- mixes persona, state, and volatile work
- turns `AGENTS.md` into a stale status document
- gives no compaction-safe startup or safety sections
- encourages drift away from Emperor as source of truth

## Compaction-Safe Doctrine

OpenClaw re-injects `AGENTS.md` sections named `Session Startup` and `Red Lines` after compaction.

That means these headings are the right place for:

- rules that must survive long sessions
- startup reminders
- safety rules
- truthfulness constraints
- thread-routing rules

Recommended content for `## Session Startup`:

- read `BOOTSTRAP.md`
- read the Emperor doctrine files named there
- check Emperor before answering status questions
- treat human thread messages as authoritative interrupts

Recommended content for `## Red Lines`:

- do not fake state changes
- do not fake task completion
- do not leak scoped data
- do not mutate durable state and then hide failure

## Prompt Budget Reality

On the local OpenClaw runtime inspected here, the default bootstrap limits are:

- `bootstrapMaxChars`: `20000` per file
- `bootstrapTotalMaxChars`: `150000` across all injected bootstrap files

Practical rules:

- keep `AGENTS.md` short and high-signal
- keep `HEARTBEAT.md` very small
- keep persona concise in `SOUL.md`
- move bulky reusable doctrine into dedicated Emperor doctrine files or scoped resources
- use examples, but do not drown the prompt in narrative

## Emperor Plugin Mapping

The Emperor plugin should teach the agent through the exact OpenClaw surfaces above.

The recommended mapping is:

- `AGENTS.md`: Emperor startup and red-line rules that must survive compaction
- `BOOTSTRAP.md`: exact Emperor reading order for each session
- `SOUL.md`: concise operator or manager persona
- doctrine files such as `EMPEROR_OPERATING_DOCTRINE.md`: the thick reference layer
- Emperor shared resources: reusable company-scoped doctrine that all relevant agents should inherit

## Example Startup Sequence

This is the kind of flow an Emperor-connected OpenClaw agent should follow every session:

1. Read `AGENTS.md`.
2. Read `SOUL.md`.
3. Read `USER.md`.
4. Read `IDENTITY.md`.
5. Read `BOOTSTRAP.md`.
6. Read the Emperor doctrine files named in `BOOTSTRAP.md`.
7. If the turn references a task, customer, project, or thread state, read Emperor before answering.
8. Use OpenClaw tools to do the real work.
9. Write durable state back into Emperor before claiming the change happened.

## Example Instruction Split For Emperor

### `AGENTS.md`

```md
## Session Startup

- Read BOOTSTRAP.md before replying.
- Re-check Emperor state when a task, project, or customer is referenced.
- In team threads, require an explicit @mention unless role doctrine says otherwise.

## Red Lines

- Do not say a task is done unless POST /tasks/{id}/result succeeded.
- Do not say work was assigned unless claim or assign succeeded.
- Do not leak private scoped resources into shared chat.
```

### `SOUL.md`

```md
Be concise, practical, and operationally honest.
Do not pad replies.
Prefer evidence over guesswork.
```

### `BOOTSTRAP.md`

```md
You are already configured.
Do not ask who you are.
Do not delete this file.

Before replying, read:
1. AGENTS.md
2. SOUL.md
3. USER.md
4. IDENTITY.md
5. EMPEROR_OPENCLAW_AGENT_RUNTIME.md
6. EMPEROR_OPERATING_DOCTRINE.md
7. EMPEROR_MCP_DIRECT_USAGE.md
```

## Final Rule

The best Emperor-connected OpenClaw agent is not the one with the most doctrine. It is the one whose doctrine is placed in the right files, survives compaction, stays within prompt budget, and keeps Emperor state truthful.
