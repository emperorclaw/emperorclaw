# Company Brain

Company Brain is Emperor's operator-approved knowledge layer. It uses existing Knowledge & Rules resources as canonical markdown, then adds graph links, tags, versions, proposals, and deterministic context resolution for humans and agents.

It is inspired by Obsidian, but it is not a personal notes clone. The job is company doctrine: reusable rules, customer/project context, operating procedures, and references that agents can safely cite.

## Source of truth

- `scopedResources.configText` remains the canonical markdown body.
- `resource_links` stores `[[wikilinks]]`, explicit links, inferred references, and unresolved links.
- `resource_tags` stores normalized tags such as `customer/acme`, `storage`, `approval`, and `operator/sop`.
- `resource_versions` snapshots every markdown body change so operators can restore older doctrine.
- `resource_proposals` is the safe default path for agent-generated learning.

Agents should propose updates unless they were explicitly granted direct resource write permission. Durable company doctrine deserves review. This is architecture, not bureaucracy.

## Operator feeding workflow

1. Capture only reusable knowledge.
2. Save it at the smallest correct scope: company, customer, project, or agent.
3. Use `#tags` for retrieval and `[[wikilinks]]` for relationships.
4. Link artifacts, tasks, or storage files instead of pasting large file contents.
5. Approve proposals only when the knowledge will still matter after the current task.

Use Agent suggestions for pending agent-proposed changes:

- **Approve** when the proposal is reusable and scoped correctly.
- **Edit and approve** when the idea is right but the wording/scope is sloppy.
- **Merge** when it belongs in an existing note.
- **Reject** when it is transient progress, speculation, duplicated, or missing evidence.
- **Ask for evidence** when the claim needs a task, thread, artifact, or resource citation.

## Agent note contract

Agents should write Company Brain notes like a shared Obsidian vault, not like chat logs.

Every new note should have:

1. A clear title that can be linked as `[[Title]]`.
2. Small frontmatter properties for scope, type, status, owner, and tags.
3. One short summary paragraph.
4. The reusable rule, SOP, template, or customer/project context.
5. Links to related notes with `[[wikilinks]]`.
6. Links to Storage artifacts or tasks when evidence is needed.

Use this shape:

```markdown
---
scope: company
type: sop
status: active
owner: operator
tags:
  - storage
  - operator/sop
  - approval
---

# Storage Discipline

Agents must use [[Emperor Storage]] for durable files and must never ask for backing blob-provider credentials.

## Rule

- Create or find the correct Storage folder before uploading.
- Upload with `folderId`.
- Verify the upload through Emperor.
- Report the artifact id and folder/path.

## Evidence

- Task: `<task-id or link>`
- Artifact: `<artifact-id or path>`

## Related

- [[Emperor Storage]]
- [[Operator Approval Rules]]
```

Emperor parses `[[wikilinks]]`, inline `#tags`, and frontmatter `tags`. The visible tree comes from resource scope, not from fake folder names inside the title.

## Obsidian-inspired conventions

Obsidian works because the primitives stay boring:

| Obsidian idea | Emperor equivalent | Agent rule |
| --- | --- | --- |
| Vault | Company Brain / Knowledge & Rules | Treat it as the shared company knowledge vault. |
| Folder explorer | Scope tree: company, customer, project, agent | Pick the smallest correct scope instead of inventing title prefixes. |
| Markdown note | `scopedResources.configText` | Write durable markdown, not chat transcript. |
| Properties | Frontmatter | Use properties for structure; do not hide rules there. |
| Wikilinks | `[[Resource Name]]` | Link related doctrine explicitly. |
| Tags | `#tag` or frontmatter `tags` | Use for retrieval categories, not decoration. |
| Graph | Resource links and inferred title mentions | Improve graph quality by linking notes deliberately. |

Do not create notes named like folders (`Acme / Project / Rule`). Use scope fields for placement and a human title for the note.

## Brain vs memory vs task notes vs Storage

| Use this | For | Not for |
| --- | --- | --- |
| Company Brain | Reusable doctrine, SOPs, scoped customer/project rules, agent operating instructions | One-off progress updates |
| Project/task notes | Execution status, blockers, decisions for one task | Company-wide rules |
| Agent/runtime memory | Runtime-local continuity and short-lived working context | Audited business doctrine |
| Storage | Files, deliverables, raw assets, exports | Rewriting file contents into markdown |

If a thing is a file, put it in Storage. If it is a reusable rule about how the company operates, put it in Company Brain and link the file.

## Wikilink and tag conventions

```markdown
# Storage Discipline

Agents must use [[Emperor Storage]] instead of asking for Bunny credentials.

Tags: #storage #operator/sop #approval
```

Guidelines:

- Prefer title-case note names in `[[wikilinks]]`.
- Use slash tags for hierarchy: `customer/acme`, `project/website-redesign`, `agent/builder`.
- Do not tag everything. Tags are indexes, not decoration.
- Unresolved `[[links]]` are allowed; the operator UI can create the missing note.
- Prefer frontmatter `tags` for agent-created notes and inline `#tags` for human-authored quick notes.
- Add a `Related` section when the note should appear clearly in the graph.

## Context resolver order

The bridge and MCP clients should use `GET /api/mcp/resources/context` instead of blindly loading every shared resource. Emperor resolves context in this order:

1. Company operating doctrine.
2. Exact customer/project/agent shared resources.
3. Explicitly selected resources.
4. One-hop outgoing links and backlinks.
5. Non-shared discoverable summaries within budget.

The response includes source ids and names so agents can cite what they loaded.

## API surface

Operator UI:

- `GET /api/resources/:id/graph`
- `GET /api/resources/:id/backlinks`
- `GET /api/resources/:id/versions`
- `POST /api/resources/:id/restore-version`
- `GET|POST /api/resources/proposals`
- `PATCH /api/resources/proposals/:id`

MCP/runtime:

- `GET /api/mcp/resources/context`
- `POST /api/mcp/resources/proposals`

## Operator checklist

Before marking a note shared or approving a proposal:

- Is this reusable knowledge, not transient progress?
- Is the scope the smallest correct one?
- Does it have useful links/tags?
- Is evidence attached or referenced?
- Should agents always receive it? If not, do not mark `isShared`.
- Are files linked through Storage instead of pasted into the note?
