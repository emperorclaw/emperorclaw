# Company Brain

Company Brain is Emperor's shared knowledge vault. It uses existing Knowledge & Rules resources as canonical markdown, then adds graph links, tags, versions, draft notes, and deterministic context resolution for humans and agents.

It is inspired by Obsidian, but it is not a personal notes clone. The job is company doctrine: reusable rules, customer/project context, operating procedures, and references that agents can safely cite.

## Source of truth

- `scopedResources.configText` remains the canonical markdown body.
- `resource_links` stores `[[wikilinks]]`, explicit links, inferred references, and unresolved links.
- `resource_tags` stores normalized tags such as `customer/acme`, `storage`, `approval`, and `operator/sop`.
- `resource_versions` snapshots every markdown body change so operators can restore older doctrine.
- Agent-created durable notes use frontmatter `status: active` by default so useful knowledge is immediately published in the vault without manual promotion.

Agents should create or update normal Knowledge & Rules notes with `status: active` by default. Use `status: draft` only when the agent is explicitly uncertain, missing evidence, or asking the operator to review before trusting the note.

## Operator feeding workflow

1. Capture only reusable knowledge.
2. Save it at the smallest correct scope: company, customer, project, or agent.
3. Use `status: active` by default for agent-created durable knowledge; use `status: draft` only for uncertain notes that need operator review.
4. Use `#tags` for retrieval and `[[wikilinks]]` for relationships.
5. Link artifacts, tasks, or storage files instead of pasting large file contents.

There is no separate review queue. Published notes live directly in the vault. Drafts are the exception: use the `drafts` filter only for notes that were intentionally marked as needing review.

## Agent note contract

Rule: status: draft only for explicitly uncertain notes; normal agent-created durable knowledge should use `status: active`.

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
| Folders | `scopedResources.path`, e.g. `Company/Fundraising` | File the note in a real folder instead of encoding one in the title. |
| Folder explorer | Scope tree (company, customer, project, agent) + folder paths within it | Pick the smallest correct scope, then a descriptive folder path. |
| Markdown note | `scopedResources.configText` | Write durable markdown, not chat transcript. |
| Properties | Frontmatter | Use `status: active` for published knowledge and `status: draft` only for explicitly uncertain notes. |
| Wikilinks | `[[Resource Name]]` | Link related doctrine explicitly. |
| Tags | `#tag` or frontmatter `tags` | Use for retrieval categories, not decoration. |
| Graph | Resource links and inferred title mentions | Improve graph quality by linking notes deliberately. |

Do not encode a folder in the note title (`Acme / Project / Rule`). Titles are
human labels; `path` is the folder. Do not create a separate approval item; if
review is truly needed, mark the note `status: draft`.

## Folders

Notes carry an Obsidian-style `path`. It is a plain slash-separated string, and
folders are **implicit** — a folder exists exactly as long as something inside
it does, so there is no folder table to keep in sync and no empty folders to
clean up.

```
Company/Fundraising
Company/Legal/Contracts
Ferrari/Audits/2026-07
```

An empty `path` means the vault root. Scope and path are independent: scope
answers *who this note belongs to*, path answers *where it is filed*.

Input is normalized on write, so all of these land on `Ferrari/XXX`:

```
/Ferrari/XXX        Ferrari/XXX/        Ferrari // XXX
```

Traversal segments (`.` and `..`) are stripped rather than resolved, because
paths also drive prefix queries — a surviving `..` would let a note claim
membership of a folder above its own. Depth is capped at 10 and each segment at
80 characters.

### Working with folders

| Task | How |
| --- | --- |
| File a note | Set `path` on create or patch. Parent folders appear automatically. |
| Move a note | Patch `path`. Send `""` or `null` to move it back to the root. |
| List one folder | `GET /api/mcp/resources?path=Company/Fundraising` |
| List a subtree | `GET /api/mcp/resources?pathPrefix=Company` |
| Read the tree | `GET /api/resources/folders` |
| Rename or move a folder | `POST /api/resources/folders` with `fromPath` and `toPath` |

Renaming a folder re-files every note beneath it and returns how many moved.
Moving a folder into its own subtree is rejected — it would orphan everything
inside it.

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

### Context budget and truncation

Two separate limits apply, and confusing them causes silent doctrine loss:

| Limit | Default | Controlled by |
| --- | --- | --- |
| Total across all notes in one context | 12000 chars | `maxChars` query param |
| Any single note | 8000 chars | `maxCharsPerResource` param, else `EMPEROR_BRAIN_MAX_CHARS_PER_RESOURCE` |

Raising `maxChars` does **not** raise the per-note ceiling. A note longer than
the per-note limit is truncated with a `...[trimmed by Emperor]` marker, and
everything after the cut never reaches the agent. Because the cut lands at the
end of the document, the sections most likely to be lost are the ones written
most recently.

Two practical consequences:

- Prefer several focused, cross-linked notes over one very long note. This is
  also better retrieval: the resolver can pick the relevant one.
- After changing doctrine, verify what the agent actually receives rather than
  trusting that the write succeeded:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$APP_URL/api/mcp/resources/context?agentId=$AGENT_ID&maxChars=12000" \
  | jq -r '.sources[] | "\(.name): \(.content|length) chars"'
```

If a note's reported length equals the per-note cap exactly, assume it was
truncated and split it.

## API surface

Operator UI:

- `GET /api/resources/:id/graph`
- `GET /api/resources/:id/backlinks`
- `GET /api/resources/:id/versions`
- `POST /api/resources/:id/restore-version`
- `GET /api/resources/folders` — folder tree with per-folder note counts
- `POST /api/resources/folders` — rename or move a folder (`fromPath`, `toPath`)

MCP/runtime:

- `GET /api/mcp/resources/context` — resolved agent context (`maxChars`, `maxCharsPerResource`)
- `GET /api/mcp/resources` — supports `path` (exact folder) and `pathPrefix` (subtree); the response carries a derived `folders` tree alongside `resources`
- `POST /api/mcp/resources` for draft or active notes, accepting `path`
- `PATCH /api/mcp/resources/:id` — patch `path` to move a note between folders

## Operator checklist

`status` and `isShared` are separate controls:

- `status: draft` / **Needs review** means the note is visible in the vault but not trusted doctrine yet.
- `status: active` / **Published** means the operator trusts the note as reusable knowledge.
- `isShared: true` / **Inject into matching agents** means the note is eligible for agent context injection for matching company/customer/project/agent scope.

Before marking a note shared or changing `status: draft` to `status: active`:

- Is this reusable knowledge, not transient progress?
- Is the scope the smallest correct one?
- Does it have useful links/tags?
- Is evidence attached or referenced?
- Should agents always receive it? If not, do not mark `isShared`.
- Are files linked through Storage instead of pasted into the note?
