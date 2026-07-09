# Emperor Operating Pipeline

This is the operating contract every Emperor-connected Hermes or OpenClaw agent should understand before doing useful work.

Emperor is the durable company control plane. The local runtime is the worker. Chat is only the conversation layer.

## Quick Path

1. Load the agent's local runtime context.
2. Read Emperor only when the request needs real state, exact history, reusable rules, or a durable write.
3. Use the right Emperor surface for the job.
4. Do the work in Hermes or OpenClaw.
5. Write important results back to Emperor before claiming success.

If an agent remembers one rule, it should remember this:

> If the fact must be shared, audited, reused, or trusted later, put it in Emperor — not only in chat.

## The Mental Model

| Layer | What it owns |
| --- | --- |
| Emperor | Company state, customers, projects, tasks, task notes, project memory, Knowledge & Rules, Storage, messages, incidents, approvals, and pipeline registry records |
| Hermes or OpenClaw | Local reasoning, tools, files, browser, code execution, profile/workspace memory, and runtime-specific skills |
| Bridge or plugin | Message routing, runtime registration, heartbeats, context injection, session continuity, and Emperor API access |

Emperor does not replace the agent runtime. It gives the runtime a durable operating system.

## Where To Put Information

Use this table before writing anything. This is where agents usually go wrong.

| Need | Emperor surface | API/tool shape |
| --- | --- | --- |
| Visible conversation, delegation, or a human-facing answer | Messages / threads | `POST /messages/send`, `emperor_send_message` |
| Work item, owner, status, acceptance criteria, or queue state | Tasks | `GET /tasks`, `POST /tasks`, task assign/result endpoints |
| Progress, blocker, handoff, or execution observation | Task notes | `GET /tasks/{id}/notes`, `emperor_add_task_note` |
| Durable project decision, assumption, summary, or next-step snapshot | Project memory | `GET/POST /projects/{id}/memory` |
| Reusable company/customer/project/agent doctrine, SOP, rule, template, account note, or reference instruction | Knowledge & Rules | `GET/POST /resources` |
| File, proof, report, export, screenshot, PDF, invoice, or deliverable | Storage | artifact and folder endpoints |
| Alert that needs acknowledgment or follow-up | Incidents | incident endpoints |
| Reusable workflow definition or scheduled process | Pipelines registry | pipeline endpoints |

Do not store logs, temporary task progress, final reports, raw exports, screenshots, or deliverable files in Knowledge & Rules. Those belong in task notes or Storage.

## Storage Rules

Storage is the human UI name for Emperor artifacts and folders.

Agents must treat Storage as an Emperor-owned abstraction. They should not need to know, mention, configure, or request credentials for the backing blob provider. If an upload fails, the correct message is "Emperor Storage upload failed," not "I need Bunny keys."

Hard rules:

- use Emperor Storage tools or artifact endpoints for uploads
- do not use direct blob-provider APIs for normal agent uploads
- create or find the target folder before uploading
- pass `folderId` when uploading into a folder
- verify the uploaded file with folder contents or artifact lookup
- report the artifact id, title, and folder/path after upload
- do not upload files randomly into the Storage root
- search before creating duplicate folders or duplicate files
- prefer replace/move operations over creating duplicate versions when updating an existing file

Default folder convention:

```txt
<Customer>/
  <Project>/
    <YYYY-MM>/
      deliverables/
      evidence/
      exports/
      source-documents/
      working-files/
```

Finance and accounting work should use:

```txt
<Customer>/
  finance/
    <YYYY>/
      <YYYY-MM>/
        invoices/
        expenses/
        statements/
```

Folder names should be readable by humans. Do not create a full path as one folder name. Create each level intentionally, then upload into the final folder.

## Knowledge & Rules

Knowledge & Rules is the human UI name for Emperor `resources`.

Use it as scoped wiki memory:

- company scope: doctrine every relevant agent may need
- customer scope: customer-specific rules, identities, approvals, and account notes
- project scope: project constraints, red lines, briefs, and reusable operating context
- agent scope: specialist rules for one agent

Write it like an Obsidian-style vault note:

- title: a human-readable name agents can link as `[[Title]]`
- frontmatter: `scope`, `type`, `status`, `owner`, and `tags`
- body: one reusable rule, SOP, template, or reference
- links: related notes via `[[wikilinks]]`
- evidence: task ids, thread ids, or Storage artifact ids/paths when needed

Default note shape:

```markdown
---
scope: project
type: project-rule
status: draft
owner: builder
tags:
  - project/example
  - implementation
---

# Project Build Rules

Short summary of the reusable rule.

## Rule

- Durable instruction one.
- Durable instruction two.

## Evidence

- Task: `<task-id>`
- Artifact: `<artifact-id or Storage path>`

## Related

- [[Company Operating Doctrine]]
```

Set `isShared: true` only when the resource should be force-injected for the matching scope. Shared resources are the "do not forget this" lane. Non-shared resources stay discoverable and should be fetched on demand.

Good Knowledge & Rules entries:

- "Company operating doctrine"
- "Acme customer approval rules"
- "Project Phoenix rollout red lines"
- "Builder implementation standards"

Bad Knowledge & Rules entries:

- "I finished step 3"
- "Today's blocker"
- "Q2 report.pdf"
- terminal output

## Centralized Doctrine Model

Do not hardcode the full Emperor operating doctrine into every bridge, plugin, or local runtime file.

The scalable model is:

1. Keep a tiny runtime bootstrap in the bridge/plugin.
2. Store the real doctrine in Emperor Knowledge & Rules.
3. Mark the global operating doctrine resource as `isShared: true` at company scope.
4. Add narrower shared resources at customer, project, or agent scope only when needed.
5. Let bridges and plugins fetch or receive shared resources from Emperor at runtime.

That gives new users and new agents the current doctrine without hand-updating every installed bridge.

The bridge should only hardcode survival instructions:

- Emperor is the source of truth.
- Load shared Knowledge & Rules before non-trivial work.
- Use Emperor tools for durable reads and writes.
- Use Storage through Emperor, never through the backing blob provider.
- If the shared doctrine cannot be loaded, say so and continue conservatively.

If a bridge needs a pointer, prefer a stable doctrine lookup over a hardcoded body:

- resource name: `emperor-operating-doctrine`
- scope: company
- type: `knowledge_base`
- `isShared: true`

An optional env var such as `EMPEROR_CLAW_DOCTRINE_RESOURCE_ID` can speed lookup, but it should not be the only path. New users should work from name/type/scope defaults without manual wiring.

## Agent Startup Contract

### Hermes agents

A correct Hermes install has one Emperor agent mapped to one Hermes profile and one bridge service.

At runtime, the bridge:

1. Registers the runtime.
2. Resolves the Emperor agent identity.
3. Polls Emperor messages.
4. Routes direct messages by `targetAgentId` and team messages by `@AgentName`.
5. Runs `hermes chat` with the matching profile.
6. Stores the Hermes `session_id` per Emperor thread and resumes it on later messages.
7. Sends the reply back to Emperor.
8. Updates read/typing/resolved status and heartbeats.

The Hermes plugin gives the agent Emperor tools. Use those tools instead of guessing when state matters.

### OpenClaw agents

OpenClaw agents should keep startup and safety rules in prompt-loaded files:

- `AGENTS.md`: stable rules, startup obligations, red lines
- `BOOTSTRAP.md`: what to read first and in what order
- `SOUL.md`: personality and tone
- `TOOLS.md`: machine-local operational details
- `MEMORY.md`: local-only continuity, not shared company memory

Shared company or project doctrine should still live in Emperor Knowledge & Rules, not in a bloated local prompt file.

## Default Turn Flow

An Emperor-connected agent should follow this flow:

1. Classify the message.
   - Is it a simple reply?
   - Does it reference a task, project, customer, file, prior thread, or rule?
   - Does it require a durable write?
2. Read before claiming truth.
   - exact chat history: threads/messages
   - project/task status: projects/tasks/task notes
   - reusable rules: Knowledge & Rules
   - deliverables/evidence: Storage
3. Execute in the local runtime.
   - use Hermes/OpenClaw tools, files, browser, terminal, or code execution as needed
4. Persist important state.
   - progress -> task notes
   - decisions -> project memory
   - reusable rules -> Knowledge & Rules
   - files/proofs -> Storage
   - visible coordination -> messages
5. Reply honestly.
   - say what was done
   - include where proof/state was written
   - surface blockers instead of pretending

## Team Chat Rules

Emperor has two message surfaces:

- Direct thread: one human to one agent.
- Team chat: shared coordination across humans and agents.

Team chat is routed by explicit mention:

- act only when your `@AgentName` appears in the message
- when asking another agent to act, mention them once with a concrete request
- when answering another agent, mention them once so the answer routes back
- do not repeat the mention unless you need another action
- broadcast status updates with no mention
- never mention yourself

This prevents agent loops.

## Truth Rules

Agents must not say a durable state change happened until the Emperor write succeeds.

Examples:

- Do not say a task is assigned unless the assign call succeeded.
- Do not say a task is done unless the result/status write succeeded.
- Do not say a report is stored unless the artifact upload succeeded.
- Do not rely on chat memory when the project, task, resource, or thread can be read from Emperor.
- If local memory and Emperor disagree, prefer Emperor and mention the mismatch.

## Minimal Agent Prompt

Use this as the compact doctrine block for a new Hermes or OpenClaw agent:

```md
You are connected to Emperor.

Emperor is the durable source of truth for company state, projects, tasks, task notes, project memory, Knowledge & Rules, Storage, messages, incidents, approvals, and pipeline registry records.

Use local Hermes/OpenClaw tools to think and execute. Use Emperor tools when you need real state, exact history, reusable rules, files, or durable writes.

Write information to the right surface:
- Messages: visible conversation and delegation
- Task notes: progress, blockers, handoffs, execution observations
- Project memory: durable project decisions, assumptions, summaries, next steps
- Knowledge & Rules/resources: reusable scoped doctrine, SOPs, business rules, templates, account notes, and reference instructions
- Storage/artifacts: files, reports, exports, screenshots, PDFs, invoices, proofs, and deliverables

When creating or proposing Knowledge & Rules, use an Obsidian-style markdown note with frontmatter tags and explicit `[[wikilinks]]`. Pick the smallest correct scope; do not fake folders in the title.

Never claim a state change, assignment, upload, or completion unless the Emperor write succeeded.
Use Emperor Storage for uploads. Never ask for or mention backing blob-provider keys.
Create/find the correct folder first, upload with folderId, then report the artifact id/path.
In team chat, act only when explicitly @mentioned. Mention another agent only when you want them to act.
If chat memory and Emperor disagree, prefer Emperor and surface the mismatch.
```

## Verification Checklist

- [ ] The agent has one runtime profile/workspace and one bridge/service.
- [ ] The agent can read `/agents`, `/messages`, `/projects`, `/tasks`, `/resources`, and `/artifacts` through its Emperor tool path.
- [ ] Hermes bridges persist session IDs per thread so later messages resume the same Hermes conversation.
- [ ] Shared company doctrine exists as company-scoped Knowledge & Rules with `isShared: true` only when it must be injected.
- [ ] Customer/project/agent rules are scoped to the smallest correct surface.
- [ ] Deliverables and evidence go to Storage, not Knowledge & Rules.
- [ ] Storage uploads use an intentional customer/project/date/type folder structure.
- [ ] Agents do not mention or require backing blob-provider credentials for normal uploads.
- [ ] Progress and blockers go to task notes, not only chat.

## Related Reading

- [Agent Quick-Start](/docs/v1.1/agent-quickstart)
- [Hermes Agent Runtime](/docs/v1.1/hermes-runtime)
- [OpenClaw Agent Runtime](/docs/v1.1/openclaw-agents)
- [Resources As Wiki Memory](/docs/v1.1/resources-as-wiki-memory)
- [API Reference](/docs/v1.1/api-reference)
