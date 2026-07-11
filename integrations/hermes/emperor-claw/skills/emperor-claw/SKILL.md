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
7. Create or update a normal `knowledge_base` resource with frontmatter `status: active` by default. Rule: status: draft only when explicitly uncertain or asking the operator to review.

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
â†’ returns { folder: { id: "<folder-id>", path: "BrandVirality Report", ... } }
```

### Create a subfolder inside an existing folder

Pass the parent's `id` as `parentFolderId`:

```
emperor_create_folder(name="Charts", projectId="<project-id>", parentFolderId="<folder-id>")
â†’ returns { folder: { id: "<subfolder-id>", path: "BrandVirality Report/Charts", ... } }
```

### Upload a file into a folder

Pass `folderId` when calling `emperor_upload_artifact`. Without `folderId` the file lands in the root of Storage with no grouping.

```
emperor_upload_artifact(filePath="/home/jose/BrandVirality/report.pdf", kind="report", projectId="<project-id>", folderId="<folder-id>")
```

### Upload multiple files into the same folder

Repeat `emperor_upload_artifact` with the same `folderId` for each file:

```
emperor_upload_artifact(filePath="/home/jose/BrandVirality/summary.pdf",   kind="report",   projectId="<id>", folderId="<folder-id>")
emperor_upload_artifact(filePath="/home/jose/BrandVirality/raw_data.csv",   kind="export",   projectId="<id>", folderId="<folder-id>")
emperor_upload_artifact(filePath="/home/jose/BrandVirality/charts/bar.png", kind="evidence", projectId="<id>", folderId="<subfolder-id>")
```

### Verify what was uploaded

```
emperor_list_folder_contents(folderId="<folder-id>")
â†’ returns { folder: {...}, folders: [...subfolders...], artifacts: [...files...] }
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
emperor_upload_artifact(filePath="/home/jose/.../report.pdf", kind="report", projectId="<id>", folderId=root_id)

# 4. Upload CSVs into the subfolder
emperor_upload_artifact(filePath="/home/jose/.../impressions.csv", kind="export", projectId="<id>", folderId=raw_id)
emperor_upload_artifact(filePath="/home/jose/.../clicks.csv",      kind="export", projectId="<id>", folderId=raw_id)

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
â†’ returns agents[].name for each agent on the team
```

Use the shortest unambiguous first name as the @mention alias (e.g. `@Viktor`, `@Katarina`, `@BrandVirality`).

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

Do not @mention the requester a second time in the same reply or in a follow-up unless you need them to take further action.

### Loop prevention — critical rules

- **Only act on team chat messages that contain your @name.** If a message does not mention you, it is addressed to someone else — do not respond.
- **@mention an agent at most once per reply.** Repeating the @mention triggers another response cycle from them.
- **Informational updates** (task complete, status, FYI) go to team chat with **no @mention**. These are broadcast-only and do not call anyone to act.
- Never @mention yourself.

### Thread history

Use `emperor_list_threads` to find the relevant thread, then `emperor_get_thread_messages` to read exact history. Do not say history is unavailable or WebSocket-only.

Do not write logs, progress reports, final deliverables, exported documents, evidence files, or task output files into Knowledge & Rules/resources.

When a user asks you to change Emperor state, call the Emperor tool first. Only report success after the tool confirms the write.
