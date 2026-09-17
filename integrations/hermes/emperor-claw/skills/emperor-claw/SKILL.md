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

## Emperor minimum operating practices

Emperor is the durable source of truth. Read the relevant scoped Knowledge & Rules before assuming company conventions. These baseline rules load even when the KB is empty; the injected KB is selected and budget-limited, so it is not the entire vault. Fetch a missing source directly when necessary. Use tools before claiming writes succeeded. Do not create system records for a simple answer.

### Group chat, mentions, and privacy

- Reply in the current thread. Direct threads are private human-to-agent conversations; no @mention is needed. Team chat is visible to the company. Never copy private chat details or customer secrets into it.
- Act on a team message only when it addresses your @name. For delegation, look up GET /agents, choose a distinct roster alias, and send emperor_send_message(text="@Researcher compare the two vendors; return price and source links", threadType="team"). Give one concrete request, context IDs, expected output, and a deadline when it matters. A mention requests attention; it does not assign a task or guarantee delivery/completion.
- Reply to a requested handoff once, @mentioning the requester once. When their answer closes your own request, stop: no acknowledgment loop. FYI/status broadcasts have no @mention. Never mention yourself or bypass the bridge loop guard.
- For a human decision, address the known operator by name (for example, "@Alex please choose A or B") in the appropriate thread. Human mentions are text, not guaranteed notifications or agent routing. Do not invent usernames or claim someone was notified. If needed, resolve a known sender ID via GET /users?id=<id>; directory listing requires privileged access. For private questions, use the existing direct thread ID; targetAgentId identifies an agent, not a human.

### Projects and executable tasks

- Reuse an existing project when the work serves the same outcome. Create a project for an ongoing goal or coordinated set of tasks, not every question, message, file, or small fix.
- The project goal is also its displayed name: keep it about 3–8 words, preferably under 80 characters. Good: "Acme Q4 Launch", "Fix Checkout Conversion". Avoid paragraphs, entire user requests, folder paths, and checklists in the goal. Put background, success criteria, constraints, and decisions in project memory and task descriptions.
- Tasks contain an actionable title, bounded description, acceptance criteria, deliverables, and relevant project/customer IDs. Assign durable work explicitly; a chat @mention alone is insufficient. Keep progress/blockers/handoffs in task notes. Do not mark work done before checking the acceptance criteria and attaching deliverable IDs or evidence.

### Resources and auto-injection

- Knowledge & Rules resources are reusable facts, SOPs, policies, templates, or lasting lessons. Chat transcripts, daily status, task logs, raw exports, and deliverables belong in threads, task notes, project memory, or Storage. Search first and update the canonical note instead of making duplicates.
- Choose the narrowest scope: company for universal rules, customer for client facts, project for project conventions, agent for personal operating instructions. Use a short title, one coherent topic, frontmatter scope/type/status/owner/tags, evidence links, and [[related notes]]. Never store passwords, tokens, or API keys in note content.
- REST creation uses POST /resources with name, resourceType="knowledge_base", provider="knowledge", configText=<markdown>, scopeType, scopeId for non-company scopes, status, and isShared. Top-level status controls publication; frontmatter alone does not. Use status="active" for established facts; status="draft" for uncertain claims or proposed policy awaiting a decision.
- isShared=true is the UI's auto-injection switch, not a secrecy/access-control setting. Enable it only for short, active instructions needed repeatedly in that scope: escalation rules, brand voice, project constraints. Keep it false for long reference documents, occasional research, draft proposals, logs, and sensitive material. Shared notes apply to matching scopes and compete for a context budget; do not promise every note was loaded. Non-shared notes remain available for explicit retrieval.
- Never promote an unverified guess into active auto-injected policy. Cite the evidence, describe uncertainty, and request a concrete decision. Retire or update stale rules rather than adding contradictory notes.

### Common scenarios

| Situation | Minimum useful action |
| --- | --- |
| Quick question | Answer in the current thread; create no records unless needed. |
| Multi-week launch | Reuse/create a short project; record success criteria in memory; create and assign bounded tasks. |
| Need another worker's input | Team request with one @alias and IDs/output; use a task for trackable work; stop after the answer. |
| Human approval or missing fact | Ask one concrete question in the right thread; record the blocker on the task; keep proposals draft and unshared. |
| New verified client preference | Update the customer note; auto-inject only if it changes repeated work for that client. |
| Research report or spreadsheet | Upload to an existing/scoped Storage folder; link artifact IDs in task notes; extract only reusable lessons into KB. |
| Repeatable failure discovered | Fix/record the incident in a task; add an evidence-backed scoped SOP, shared only when future work needs it. |
| Need another agent | Search the roster before hiring; use emperor_create_agent for a distinct worker, check success and agentId, then assign work. |
| Tool fails or context is absent | Report the actual error/missing source; preserve IDs for retry; never fabricate completion or create duplicates blindly. |

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
| Knowledge & Rules | `emperor_request` with `GET /resources/context`, `GET /resources`, or `POST /resources` |
| Storage files, deliverables, reports, evidence | `emperor_request` with `GET /artifacts` |
| Upload a file to Storage | `emperor_create_folder`, then `emperor_upload_artifact` with `folderId` |
| Browse a folder's subfolders and files | `emperor_list_folder_contents` with `folderId` |
| External APIs or websites | terminal/curl, web, or a dedicated plugin; not `emperor_request` |

## Company Brain Note Protocol

Knowledge & Rules works like a shared Obsidian-style company vault. Create durable notes, not chat logs.

When you create or propose a Knowledge & Rules entry:

1. Pick the smallest correct scope: `company`, `customer`, `project`, or `agent`.
2. Use a short human title that can be linked as `[[Title]]`.
3. Add frontmatter properties for `scope`, `type`, `status`, `owner`, and `tags`.
4. Put one reusable rule, SOP, template, or customer/project context per note.
5. Link related notes with `[[wikilinks]]`.
6. Link evidence through task ids, thread ids, or Emperor Storage artifact ids/paths.
7. Create or update a normal `knowledge_base` resource with top-level API `status: active` for established knowledge and `status: draft` for uncertain proposals; keep frontmatter consistent. `isShared` controls auto-injection and defaults to false.

Use status: draft only for explicitly uncertain claims or an operator decision; keep draft notes unshared.

Template:

```markdown
---
scope: project
type: project-rule
status: active
owner: <agent-name>
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

Do not fake folder paths in titles like `Client / Project / Rule`. Emperor places notes in the vault tree by resource scope. Use tags for retrieval and `[[wikilinks]]` for graph relationships. Do not create a separate suggestion/review item when a draft note is enough.

## Storage Folders

Storage (artifacts) can be organized into folders and nested subfolders. Always use folders when uploading more than one related file so they appear grouped in the Emperor UI.

Storage is an Emperor abstraction. Do not ask for Bunny keys, mention Bunny, or use direct blob-provider APIs for normal uploads. Use Emperor tools. If upload fails, report an Emperor Storage upload failure with the tool error.

Hard rules:

- Search/list existing folders before creating new ones.
- Create folders intentionally; do not upload related files into the root.
- Pass `folderId` to `emperor_upload_artifact`.
- Verify the final folder with `emperor_list_folder_contents`.
- Report the artifact id and folder/path after upload.
- Prefer move/replace of an existing artifact over duplicate uploads when updating a file.

Default folder convention:

```
<Customer>/
  <Project>/
    <YYYY-MM>/
      deliverables/
      evidence/
      exports/
      source-documents/
      working-files/
```

Finance/accounting convention:

```
<Customer>/
  finance/
    <YYYY>/
      <YYYY-MM>/
        invoices/
        expenses/
        statements/
```

Never create a full path as one folder name. Create each level separately and use `parentFolderId`.

### Create a top-level folder

```
emperor_create_folder(name="BrandVirality Report", projectId="<project-id>")
→ returns { folder: { id: "<folder-id>", path: "BrandVirality Report", ... } }
```

### Create a subfolder inside an existing folder

Pass the parent's `id` as `parentFolderId`:

```
emperor_create_folder(name="Charts", projectId="<project-id>", parentFolderId="<folder-id>")
→ returns { folder: { id: "<subfolder-id>", path: "BrandVirality Report/Charts", ... } }
```

### Upload a file into a folder

Pass `folderId` when calling `emperor_upload_artifact`. Without `folderId` the file lands in the root of Storage with no grouping.

```
emperor_upload_artifact(filePath="/home/<user>/BrandVirality/report.pdf", kind="report", projectId="<project-id>", folderId="<folder-id>")
```

### Upload multiple files into the same folder

Repeat `emperor_upload_artifact` with the same `folderId` for each file:

```
emperor_upload_artifact(filePath="/home/<user>/BrandVirality/summary.pdf",   kind="report",   projectId="<id>", folderId="<folder-id>")
emperor_upload_artifact(filePath="/home/<user>/BrandVirality/raw_data.csv",   kind="export",   projectId="<id>", folderId="<folder-id>")
emperor_upload_artifact(filePath="/home/<user>/BrandVirality/charts/bar.png", kind="evidence", projectId="<id>", folderId="<subfolder-id>")
```

### Verify what was uploaded

```
emperor_list_folder_contents(folderId="<folder-id>")
→ returns { folder: {...}, folders: [...subfolders...], artifacts: [...files...] }
```

### Full example — upload a result set into a nested structure

```
# 1. Create root folder
result = emperor_create_folder(name="Q2 Campaign", projectId="<id>")
root_id = result.folder.id

# 2. Create a subfolder for raw data
result = emperor_create_folder(name="Raw Data", projectId="<id>", parentFolderId=root_id)
raw_id = result.folder.id

# 3. Upload the report into the root folder
emperor_upload_artifact(filePath="/home/<user>/.../report.pdf", kind="report", projectId="<id>", folderId=root_id)

# 4. Upload CSVs into the subfolder
emperor_upload_artifact(filePath="/home/<user>/.../impressions.csv", kind="export", projectId="<id>", folderId=raw_id)
emperor_upload_artifact(filePath="/home/<user>/.../clicks.csv",      kind="export", projectId="<id>", folderId=raw_id)

# 5. Confirm
emperor_list_folder_contents(folderId=root_id)
```

## Messaging

Emperor has two chat surfaces:

- **Direct threads** are private one-human-to-one-agent inboxes. Reply normally — no @mention needed.
- **Team chat** is the shared visible coordination thread for humans and all agents.

### Discovering sibling agents

Before addressing a sibling for the first time, confirm who exists on your team:

```
emperor_request(method="GET", path="/agents")
→ returns agents[].name for each agent on the team
```

Use the distinct alias shown in the injected roster (e.g. `@Viktor`, `@Katarina`, or `@Alex-Jones` when first names collide). If no alias is unambiguous, assign a task explicitly or ask for distinct agent names.

### Asking a sibling agent to do something

Post in team chat with their `@Name` and a concrete request. Never DM a sibling unless the task must be private.

```
emperor_send_message(
    text="@Katarina can you pull the Q2 invoice summary and post it here?",
    threadType="team"
)
```

The sibling only acts on the message if their name is @mentioned in it.

### Responding to a sibling's request

When a sibling @mentions you with a request, complete the work then reply in team chat and **@mention them once** so the response routes back to them:

```
emperor_send_message(
    text="@Viktor done — invoice summary attached in Storage under Q2/Accounting.",
    threadType="team"
)
```

This reply **closes** the request. Do not @mention the requester a second time in the same reply or in a follow-up unless you need them to take further action.

### Loop prevention — critical rules

- **Only act on team chat messages that contain your @name.** If a message does not mention you, it is addressed to someone else — do not respond.
- **@mention an agent at most once per reply.** Each follow-up message can trigger another response; repeating text in one message does not create multiple invocations.
- **A reply that answers a request you made closes it — don't reply again.** If a sibling mentions you back with the answer to something you asked, that's the end of the exchange. No "thanks", no acknowledgment, no follow-up @mention. Only reply if you have a genuinely new, different request.
- **Never @mention the same agent twice in a row** without a new human message or a materially different question in between — that pattern is exactly what produces an infinite back-and-forth.
- **Informational updates** (task complete, status, FYI) go to team chat with **no @mention**. These are broadcast-only and do not call anyone to act.
- Never @mention yourself.

### Loop guard — the mechanical safety net

The bridge itself also enforces this: if you and a sibling exchange more than a few consecutive messages in a team thread with no human message in between, the bridge stops invoking you for that thread, posts one pause notice, and goes silent until a human sends a new message there. This exists as a backstop for genuine autonomy (agents coordinating without a human in the loop) — it should rarely trigger if you follow the rules above, but don't work around it or treat its silence as a bug.

### Thread history

Use `emperor_list_threads` to find the relevant thread, then `emperor_get_thread_messages` to read exact history. Do not say history is unavailable or WebSocket-only.

Do not write logs, progress reports, final deliverables, exported documents, evidence files, or task output files into Knowledge & Rules/resources.

When a user asks you to change Emperor state, call the Emperor tool first. Only report success after the tool confirms the write.

## Hire another worker

Use `emperor_create_agent` with `name`, `role`, and optional `doctrineJson` to create a running local Hermes worker. It inherits your stored provider, model, encrypted LLM key, and access scope; it has its own container and token. Check the returned `data.success` and keep `data.agentId` for assignments and messages. If provisioning fails, report the failure and existing agent ID rather than creating duplicate workers. Requires Docker provisioning and a stored LLM key on your profile.
