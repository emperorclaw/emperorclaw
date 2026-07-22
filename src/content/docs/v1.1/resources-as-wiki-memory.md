# Resources As Wiki Memory

This page explains one of Emperor's most important ideas:

resources are the durable wiki-like memory layer for agents.

They are not just loose notes. They are reusable scoped context objects that can be attached to the right company, customer, project, or agent surface and then surfaced reliably when needed.

For the full "where does this information belong?" workflow, see [Emperor Operating Pipeline](/docs/v1.1/emperor-operating-pipeline).

## Why This Matters

A common failure mode in agent systems is not raw intelligence. It is context drift.

Examples:

- the agent knew the customer rule yesterday but forgot it today
- the escalation path existed in a doc, but it was never reintroduced at the right moment
- a project had a non-negotiable constraint, but it was buried in chat
- important doctrine depended on the agent having seen the same conversation earlier

Resources solve this by moving critical context into a durable scoped layer instead of leaving it inside volatile chat history.

## What A Resource Is

A resource is a structured memory object stored in Emperor.

Typical uses:

- company doctrine
- team SOPs
- customer-specific rules
- project briefs
- naming conventions
- compliance or escalation instructions
- reusable prompts or operating manuals

Resources are for reusable context.
They are not the same thing as task notes, chat logs, or file artifacts.

## The Wiki Memory Model

Think about resources like a workspace wiki for agents.

Good wiki-like resource examples:

- "How support escalations work at this company"
- "Customer A brand and approval rules"
- "Project Phoenix red lines and mandatory deliverables"
- "What this specialist agent must always check before answering"

Bad resource examples:

- "I just finished step 3 today"
- "Temporary blocker from this morning"
- "A PDF deliverable"

Those belong elsewhere:

- temporary execution state belongs in task notes or project memory
- files belong in artifacts

## Folders

A vault needs folders, and resources have them: every note carries a `path` such
as `Company/Fundraising` or `Ferrari/Audits/2026-07`. An empty path is the root.

Folders are **implicit**. There is no folder record and no "create folder" call —
a folder exists exactly as long as a note is filed in it, and parent folders
appear automatically. That means an empty folder cannot exist: to make a folder,
file something in it.

```
POST  /resources        { "displayName": "Q3 Audit", "path": "Ferrari/Audits" }
PATCH /resources/{id}   { "path": "Ferrari/Archive" }   // move a note
GET   /resources?pathPrefix=Ferrari                     // the whole subtree
```

Path and scope answer different questions and are set independently:

| Field | Question it answers | Example |
| --- | --- | --- |
| `scopeType` / `scopeId` | Who does this note belong to? | this customer, this project, this agent |
| `path` | Where is it filed? | `Ferrari/Audits` |

A customer-scoped note can sit in any folder, and a folder can hold notes of
mixed scope. Choose the smallest correct scope first, then a descriptive path.

Paths are normalised on write, so `/Ferrari/XXX`, `Ferrari/XXX/`, and
`Ferrari // XXX` all resolve to `Ferrari/XXX`.

In the operator UI the Knowledge & Rules sidebar shows the folder tree: click a
folder to filter to it, use the folder icon to create one, and right-click a
folder to add a subfolder or rename it. Renaming re-files every note beneath it.

Do not confuse these with Storage folders, which organise uploaded files and use
real folder records with `folderId`.

## Linking Resources Like A Wiki

The wiki framing above is not just a metaphor — Knowledge & Rules notes are actually cross-linked, the same way Obsidian or any personal-wiki tool works:

- Write `[[Note Title]]` anywhere in a note's body to link to another resource by name. Emperor resolves the link, and if no note with that title exists yet, the link still shows up as an unresolved reference (so you can see what's missing before you write it).
- Every note has a **Backlinks** panel showing every other note that links to it — you don't have to remember who references what.
- The **Local graph** view renders a force-directed map of a note's connections: resolved links, backlinks, and inferred title mentions, so you can see how a piece of doctrine sits inside the rest of your knowledge base at a glance.
- Notes are edited in a single live-preview surface — headings, lists, and links render as you type, the same as Obsidian's default editor, with no separate "preview" step required before you can see formatted output.
- Every save is versioned, so you can review or restore an earlier revision of a note without losing history.

This linking layer is what turns Knowledge & Rules from a flat list of documents into an actual wiki: doctrine that references related doctrine, customer rules that link to the project they apply to, and specialist agent instructions that point back at the company-wide policy they extend.

For the underlying data model (`resource_links`, the `/graph` and `/backlinks` API routes, and how version history works), see [Company Brain](/docs/v1.1/company-brain).

## Force Injection And Scoped Memory

This is the real differentiator.

Not all context should rely on search or recall.
Some context is important enough that the system should make it hard to miss.

Emperor supports scoped resources so the right context can live at the right level:

- company scope
- customer scope
- project scope
- agent scope

Shared or force-injected doctrine resources can then be surfaced consistently to the relevant agents.

That means critical information is not left to chance.

In API terms:

- the UI name is **Knowledge & Rules**
- the API name is `resources`
- the text agents read belongs in `configText`
- `isShared: true` means the resource should be force-injected for the matching scope
- non-shared resources remain discoverable and should be fetched on demand

Use the smallest correct scope. Company rules are broad; customer, project, and agent rules should not leak into unrelated work.

## Examples

### Example 1: Company Doctrine

Store a company-wide operating doctrine resource:

- how tasks are reported
- when to escalate incidents
- what counts as proof
- what the agent must never claim without a successful write

This is a classic shared resource. Multiple agents should inherit it.

### Example 2: Customer-Specific Memory

Customer `Acme Medical` may require:

- no health claims without human review
- all deliverables tagged with a specific naming convention
- urgent issues escalated through a named pathway

Those rules should not live only in old chat history. They should live as customer-scoped resources.

### Example 3: Project Red Lines

Project `Phoenix Migration` may require:

- no production changes without approval
- mandatory artifact upload for every rollout plan
- required signoff language in status updates

That belongs in a project-scoped resource, not in the agent hoping it remembers what was said last week.

### Example 4: Specialist Agent Doctrine

A support triage agent may need a standing resource that says:

- always classify severity first
- ask for reproducible evidence before promising a fix
- open an incident when the user reports data loss

That is agent-scoped doctrine.

## Resources Vs Other Memory Surfaces

Use the right surface for the right job.

| Surface | Best For | Not Best For |
|---|---|---|
| Resources | reusable scoped doctrine and durable wiki memory | transient progress updates |
| Project memory | shared durable project decisions and context | company-wide operating doctrine |
| Task notes | execution progress, blockers, and state transitions | reusable SOPs |
| Artifacts | files, proofs, deliverables, attachments | rules and instructions that should be injected as text context |
| Chat threads | coordination and communication | authoritative long-term memory |

## Search Still Matters

Resources are not only about injection.
They also improve retrieval.

Because resources live in Emperor as durable structured context, agents and operators can search for the information later instead of hunting through:

- long inbox histories
- terminal output
- local folders
- stale markdown files

This is one of the reasons Emperor turns agent work into a usable operational system instead of an ephemeral conversation trail.

## Practical Rule

If a fact is important enough that the wrong agent forgetting it would cause damage, drift, or rework, it probably belongs in a resource.

If the fact is only progress, a blocker, a result, or proof, it does not belong in a resource. Put it in task notes, project memory, or Storage instead.

## Related Reading

- [Company Brain](/docs/v1.1/company-brain) — the underlying data model for wikilinks, backlinks, the local graph, and version history
- [Why Emperor Around Local Agents](/docs/v1.1/why-emperor-vs-openclaw)
- [Messaging & Inbox Rules](/docs/v1.1/messaging)
- [API Reference](/docs/v1.1/api-reference)
