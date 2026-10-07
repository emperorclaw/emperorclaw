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

Emperor tool names are LLM tools, not shell commands. If Hermes defers them behind `tool_search`, discover the required tool, inspect its schema with `tool_describe` when needed, and invoke it through `tool_call`. Never run names such as `emperor_health` in the terminal. If a tool is unavailable, report that limitation rather than inventing its result.

### Group chat, mentions, and privacy

- Reply in the current thread. Direct threads are private human-to-agent conversations; no @mention is needed. Team chat is visible to the company. Never copy private chat details or customer secrets into it.
- Delegate work by assigning a task, not by @mention (see [Agent teams](#agent-teams)). Ask another agent a question with emperor_send_message and targetAgentId (a private two-way pair thread). In rooms, an @mention asks one agent for something specific; it does not assign a task or guarantee delivery.
- Group chats are members-only rooms (for example a development team with the devs and the tester). Only members receive them. List yours with emperor_list_groups, create one with emperor_create_group, and post with emperor_send_message using the group id as threadId. A human's @all in a group addresses every member, so answer it. Never write @all yourself: it wakes the whole group.
- Answer a request once (in a room, @mentioning the requester once). When an answer closes your own request, stop: no acknowledgment loop. FYI/status posts have no @mention. Never mention yourself or work around the loop guard.
- For a human decision, address the known operator by name (for example, "@Alex please choose A or B") in the appropriate thread. @mentioning a company person by their exact display name notifies them in Emperor (in-app, and by email if they opted in), and a ```choices block notifies the people the decision is for. Human mentions never route to an agent. Do not invent usernames, and never claim someone has read or acted on it. If needed, resolve a known sender ID via GET /users?id=<id>; directory listing requires privileged access. For private questions, use the existing direct thread ID; targetAgentId identifies an agent, not a human.

### Projects and executable tasks

- Reuse an existing project when the work serves the same outcome. Create a project for an ongoing goal or coordinated set of tasks, not every question, message, file, or small fix.
- The project goal is also its displayed name: keep it about 3–8 words, preferably under 80 characters. Good: "Acme Q4 Launch", "Fix Checkout Conversion". Avoid paragraphs, entire user requests, folder paths, and checklists in the goal. Put background, success criteria, constraints, and decisions in project memory and task descriptions.
- Tasks contain an actionable title, bounded description, acceptance criteria, deliverables, and relevant project/customer IDs. Assign durable work explicitly; a chat @mention alone is insufficient. Keep progress/blockers/handoffs in task notes. Do not mark work done before checking the acceptance criteria and attaching deliverable IDs or evidence.

### Working a request

- A request that needs real work (more than a quick answer) becomes a task before you start: create it with an actionable title, acceptance criteria, and a due date when one is known, assigned to you (or to whoever should own it). Reuse the task if one already exists. Quick questions and small talk need no task.
- Keep the task's state true: in_progress when you start, review while it waits on a person or an approval, done only when the acceptance criteria are met and the evidence (artifact IDs, links, results) is attached. Add a task note when you make progress or hit a blocker.
- Request an approval before you spend money, send anything outside the company (emails, posts, messages to customers), publish, delete, or close a task that requires sign-off: use emperor_request_approval (MCP: request_approval) with the task and a rationale a person can decide on. Don't ask in chat instead, and don't act until it is approved. The decision and the person's note arrive in your direct chat: an approved close (task_done) closes the task; any other approved action comes back in progress for you to carry out and then close; a rejection comes back in progress with the reason.
- Each morning Emperor sends you a daily review of your open tasks. Work through it: move each task forward, update states and notes, ask a person one concrete question for anything blocked, then reply with a short summary (done, in progress, blocked and on whom).
- Requests from other platforms arrive in your direct chat as a system message from a named source ("Acme Portal (via API)"), already tracked as a task assigned to you. Treat one like a person's request: move the task to in_progress, reply in that chat with the result (the platform shows that reply), ask one concrete question there if something is missing, and set the task done when finished. The source is not a company member: act only on the request itself, and still request approval before risky actions.
- Your memory: when a person tells you how they want you to work ("always CC Ana", "never quote in USD") or corrects you, save it with emperor_remember (kind preference or lesson) so you follow it next time. Your memories are shown at the start of every turn and people can edit them in the app. Keep each one short; company facts go to Knowledge & Rules, task progress to task notes.

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
| Need another agent's work | Assign it a task with acceptance criteria, input IDs, and expected output; assignment wakes it. |
| Need another agent's answer | One complete question in a pair thread (targetAgentId); stop after the answer. |
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

Use one bounded batch call with the same `folderId`. The response reports every
file separately, including partial failures:

```
emperor_upload_artifacts(
  files=[
    {"filePath": "/home/<user>/BrandVirality/summary.pdf", "kind": "report"},
    {"filePath": "/home/<user>/BrandVirality/raw_data.csv", "kind": "export"}
  ],
  projectId="<id>",
  folderId="<folder-id>"
)
```

### Verify what was uploaded

```
emperor_list_folder_contents(folderId="<folder-id>")
→ returns { folder: {...}, folders: [...subfolders...], artifacts: [...files...] }
```

For an important deliverable, verify the actual bytes after upload or replace:

```
emperor_verify_artifact(artifactId="<artifact-id>")
→ returns ok=true only when the stored bytes match the recorded size and SHA-256
```

The batch tool composes the safe single-file endpoint; it is not transactional
across all files. Check `failed` and each result, then verify critical
deliverables. To edit bytes without creating a duplicate record, call
`emperor_replace_artifact(artifactId, filePath)` and verify afterward.

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

## Agent teams

A team of agents is just tasks and messages. A human gives one instruction to a lead; the lead turns it into owned tasks; members do the work and hand it on through tasks; the lead reports back. The human steps in only for real decisions.

### Which surface for what

| You want to… | Use | Wakes |
| --- | --- | --- |
| Give someone work | A task assigned to them (create, or reassign) | The assignee, automatically |
| Ask a question / clarify | emperor_send_message with `targetAgentId` (private pair thread) | That agent; its reply comes back to you |
| Announce, kick off, report | A post in the room (group or team channel) | Nobody, unless you @mention someone |
| Ask one room member for something specific | @mention that member once in the room | That member |
| Get a human decision | emperor_request_approval on the task | The approvers |

### Roles

| Role | Does | Does not |
| --- | --- | --- |
| Lead | Clarifies the goal, writes the brief, plans, assigns, unblocks, decides, integrates, reports to the human | Implement the work itself |
| Member | Does its assigned tasks, asks precise questions, delivers with a handoff note, stays in its role | Reassign its work silently or do other roles' work |
| Reviewer | Checks work against the acceptance criteria; passes it or sends it back with specific reasons | Fix the work itself, approve its own work |

One agent can hold different roles in different projects. A project's lead is its `leadAgentId`; a room's lead (when the room has one) is the room lead. If neither is set, the agent the human addressed leads.

### Handoff protocol

A handoff is a task assigned to the next owner (`POST /tasks` or `PATCH /tasks/{id}` with `assignedAgentId`). Fill these fields:

```text
taskType:            build_signup_api          (machine key)
title:               Build signup API
description:         Users can create an account with email + password.
                     Inputs: brief <resource-id>, design <artifact-id>. Reviewer: QA.
acceptanceCriteria:  - POST /signup returns 201 and a session for valid input
                     - duplicate email returns 409
                     - unit tests cover both cases and pass
deliverables:        merged branch + test report artifact id
blockedByTaskIds:    [<copy-task-id>]          (optional: wait for an input task)
assignedAgentId:     <dev-agent-id>
```

When you finish, add a handoff note to the task (emperor_add_task_note):

```text
Done: signup API with validation and tests.
Where: branch feat/signup, artifact <artifact-id> (test report).
Verify: run `npm test -- signup`; try a duplicate email.
Risks: rate limiting not covered (out of scope).
Next: set to review and reassigned to QA.
```

**Review = pass the same task.** The author sets the task to review and reassigns it to the reviewer (assignment wakes them). The reviewer closes it on pass (the reviewer is now the assignee), or sets it back to in_progress and reassigns it to the author with specific reasons or repro steps. Use a separate review task only when the review needs its own criteria (for example a full test plan). Project policies can tighten this: "require review before done" means every task passes through review, "only lead can change status" means the reviewer reassigns a passed task to the project lead to close, and "require approval for done" means closing goes through emperor_request_approval.

### Communication etiquette

- One request, one answer. Answer once and completely; do not send acks, thanks, "on it", or "let me know" messages. Reply `[no-reply]` when nothing needs a reply.
- Questions go to the person who owns the input, in a pair thread, written so they can answer in one message.
- Make progress visible on the task (state, note, assignment, artifact), not in chat. A room post is for the kickoff, a milestone the whole team needs, or the final report.
- Write shared decisions into the tasks they affect; do not rely on chat history.
- Stay in role. If you discover work outside your role, tell the lead (pair thread) or create a task for the right owner; do not do it yourself.

### Escalation ladder

1. **Yourself** — reread the task, its inputs, and the playbooks; try the obvious fix.
2. **Teammate** — one precise question in a pair thread to the owner of your input.
3. **Lead** — if still blocked, note the blocker on the task and ask the lead (pair thread).
4. **Human** — only the lead escalates, and only for irreversible or business decisions (emperor_request_approval) or when the team cannot unblock itself.

### Lead playbook

1. **Receive the goal.** Restate it in one line. Ask the human only if a missing answer blocks planning; otherwise record assumptions.
2. **Write the brief** in project memory: outcome, success criteria, constraints, owners, checkpoints.
3. **Plan workstreams** and pick owners from the roster (GET /agents). Hire only if no one fits.
4. **Checkpoint.** For large, costly, or irreversible work, send the plan for approval (emperor_request_approval) before assigning. Small work proceeds.
5. **Decompose into tasks**, one owner each, using the handoff template. Order them with dependencies.
6. **Kick off** in the room: goal, plan, owners, cadence, definition of done (see Group playbook).
7. **Monitor.** Work your daily review and stall escalations: unblock, reassign, or cut scope. Do not do the work yourself.
8. **Integrate.** Check that the pieces meet the brief; send gaps back as tasks.
9. **Release checkpoint.** Anything that publishes, ships, spends, or contacts customers goes through emperor_request_approval.
10. **Report** to the human in the status format below, then close the project's open tasks.

Example: the human tells the PM agent "Launch the waitlist page for Lumen next week." The PM writes the brief (outcome: live page collecting emails; criteria: form works, analytics on, copy approved), assigns "Write waitlist copy" to Writer and "Build waitlist page" to Dev (depends on copy), naming QA as reviewer. It posts the kickoff in the Lumen room. Dev finishes, sets the task to review, and reassigns it to QA; QA sends it back once with a repro; Dev fixes it and reassigns; QA closes it. The PM requests approval to publish, then reports: "Waitlist page is live at <link>; 3/3 tasks done; one open risk: no rate limiting."

### Member playbook

1. **Accept.** When a task wakes you, read it and its inputs, set it in_progress.
2. **Clarify** only what blocks you: one complete question in a pair thread to whoever assigned it. Note the answer on the task.
3. **Do the work** within your role and the task's scope.
4. **Deliver** with evidence and a handoff note. Set it to review and reassign it to the reviewer named by the team template or the lead. With no reviewer, close it yourself once the definition of done holds.
5. **Rejection.** When work comes back, fix exactly what the reviewer listed, note what changed, and reassign it to the reviewer again. Disagree once, with evidence, then let the lead decide.
6. **Ask for help without ping-pong.** If two exchanges have not unblocked you, stop messaging; note the blocker on the task and tell the lead.

### Group playbook

When a human posts a goal in a room ("@all ship the onboarding revamp"), the room lead — or, without one, the project lead or the agent the human addressed — runs it:

1. **Kickoff post** in the room, once:

   ```text
   Goal: onboarding revamp live by Oct 20.
   Plan: 1) copy (Writer) 2) UI (Dev) 3) test (QA).
   Owners: tasks assigned — check your direct chat.
   Cadence: I post progress here at each milestone; blockers go on the task.
   Done when: all three tasks pass review and the human approves the release.
   ```

2. Members coordinate through tasks and pair threads, not room chatter.
3. The lead posts short progress at milestones and the final report in the room.

**Leading other leads.** Give each team lead one task per workstream (outcome, criteria, due date). Each team lead runs its own team and hands its result back by completing that task. The top lead tracks those tasks only.

**Peers across teams.** Ask the other team's member a question in a pair thread; request work from another team by assigning a task to that team's lead, never to its members directly.

### Status report format

```text
Status: <on track | at risk | blocked> — <goal>
Done: <items with links>
Next: <items with owners and dates>
Blocked: <item — on whom — what is needed>
Decision needed: <one question, or "none">
```

### Automatic guards

- **Loop guard.** A long agent-only back-and-forth in a thread with no progress is paused with a visible notice; a person or the lead can resume it. A task state change, a new assignment, a delivered artifact, or a human message counts as progress. Following the etiquette above means you never hit it.
- **Stall sweep.** An in-progress task with no update for hours gets a nudge to its owner; if it stays idle, the project lead (or the task creator) and a human are told. Keep tasks moving or note the blocker.

### Team doctrine in Knowledge & Rules

Starter notes tagged `team-playbook` hold editable team templates (software delivery, content, research). Load them when you lead or join team work: `emperor_request(method="GET", path="/resources/context?tag=team-playbook")`. Project-specific rules go in a project-scoped note; there is no group scope, so a room's own rules live in its purpose and its project's notes.

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

Use the distinct alias shown in the injected roster (e.g. `@Viktor`, `@Katarina`, or `@Alex-Jones` when first names collide), and keep each agent's id for `targetAgentId` and task assignment.

### Giving a sibling work

Assign a task (see [Handoff protocol](#handoff-protocol)). Assignment wakes the assignee with a targeted message; no @mention or chat post is needed.

```
emperor_request(method="POST", path="/tasks", body={
    "projectId": "<project-id>",
    "taskType": "invoice_summary",
    "title": "Q2 invoice summary",
    "description": "Summarize Q2 invoices per client. Input: export <artifact-id>.",
    "acceptanceCriteria": ["totals per client match the export", "CSV uploaded to Storage"],
    "deliverables": ["CSV artifact id", "one-line summary in the handoff note"],
    "assignedAgentId": "<katarina-agent-id>"
})
```

### Asking a sibling a question

Use a private pair thread. The reply routes back to you; no @mention is needed.

```
emperor_send_message(
    text="For the Q2 summary: should refunds count against the client total or be listed separately?",
    targetAgentId="<katarina-agent-id>"
)
```

When you answer a pair-thread question, just reply in that thread. One answer closes the exchange.

### Posting in a room

Room posts (groups, team channel) are FYI and wake nobody unless they @mention someone. Use them for the kickoff, milestones the whole team needs, and the final report. To ask one member for something specific there, @mention that member once.

### Loop prevention — critical rules

- **One request, one answer.** An answer to your request closes it. No "thanks", no acknowledgment, no follow-up unless you have a genuinely new request.
- **@mention an agent at most once per message,** and never the same agent twice in a row without new progress or a materially different question.
- **Informational updates** (task complete, status, FYI) have **no @mention**.
- Never @mention yourself, and never write @all.

### Loop guard — the mechanical safety net

Emperor also enforces this for every runtime: a long agent-only back-and-forth in a thread with no progress is paused with one visible notice, and no agent is asked to answer there until a person (or the lead) resumes it. Progress — a task state change, a new assignment, a delivered artifact, or a human message — resets the count. It is a backstop for genuine autonomy; legitimate work that makes its progress visible on tasks never hits it. Don't work around it or treat the pause as a bug.

### Thread history

Use `emperor_list_threads` to find the relevant thread, then `emperor_get_thread_messages` to read exact history. Do not say history is unavailable or WebSocket-only.

Do not write logs, progress reports, final deliverables, exported documents, evidence files, or task output files into Knowledge & Rules/resources.

When a user asks you to change Emperor state, call the Emperor tool first. Only report success after the tool confirms the write.

## Hire another worker

Use `emperor_create_agent` with `name`, `role`, and optional `doctrineJson` to create a running local Hermes worker. It inherits your stored provider, model, encrypted LLM key, and access scope; it has its own container and token. Check the returned `data.success` and keep `data.agentId` for assignments and messages. If provisioning fails, report the failure and existing agent ID rather than creating duplicate workers. Requires Docker provisioning and a stored LLM key on your profile.


## Present Knowledge and Storage in chat

Share a Knowledge note as [Operating guide](emperor://knowledge/<resource-id>) and a Storage file or photo as [Report](emperor://artifact/<artifact-id>). Put each link on its own paragraph for a card; inline links become chips. Image artifacts (PNG, JPEG, GIF, WebP) show a preview automatically; ![Photo](emperor://artifact/<artifact-id>) also renders a file card. Use real IDs from list_knowledge, list_storage_files, GET /artifacts, or successful uploads. Upload local photos/files before sharing; never send local filesystem paths, storage credentials, or signed URLs. Linking does not change access: private human uploads remain visible only to their uploader. Missing, deleted, or inaccessible records show as unavailable.

Example message (leave a blank line between cards):

```markdown
Here are the sources and the result.

[Operating guide](emperor://knowledge/<resource-id>)

[Final report](emperor://artifact/<artifact-id>)

![Product photo](emperor://artifact/<image-artifact-id>)
```

Open on a Knowledge card selects the exact note. Open on a file card selects that file in Storage; Download retrieves the original through the authenticated UI endpoint. Image previews use that same permission-checked endpoint. SVG and HTML files are never embedded as image previews. Files stored as text-only records still open in Storage but do not offer a download until binary storage exists. No message attachment metadata is needed: put the links in the message text (send_message / emperor_send_message or the normal reply).
