import { createHash } from "crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { companies, scopedResources } from "@/db/schema";
import { createScopedResource, updateScopedResource } from "@/lib/resources";
import { notify, companyAdminIds } from "@/lib/notifications";

/**
 * Default Knowledge & Rules scaffold created for a brand-new company.
 *
 * Folders in Knowledge & Rules are implicit — they exist only because a note
 * lives at that path — so the scaffold ships one starter note per top-level
 * folder rather than a folder table. The four folders match how the operating
 * doctrine already tells agents to scope knowledge: company-wide rules,
 * agent operating instructions, project conventions, and client facts.
 *
 * Injection budget: shared notes (isShared) are force-injected into every
 * agent on every run and compete for a small context budget, so only the short
 * core lives there (company overview, brand voice, agent operating rules).
 * Team playbooks and templates are NOT shared; they carry the `team-playbook`
 * tag so agents load them on demand (get_knowledge_context with tagFilters, or
 * GET /resources/context?tag=team-playbook).
 */
export const STARTER_KNOWLEDGE_FOLDERS = ["Company", "Agents", "Projects", "Customers"] as const;

type StarterNote = {
    name: string;
    displayName: string;
    path: string;
    isShared: boolean;
    content: (companyName: string) => string;
};

function frontmatter(scope: string, type: string, tags: string[], owner = "operators") {
    return [
        "---",
        `scope: ${scope}`,
        `type: ${type}`,
        "status: active",
        `owner: ${owner}`,
        `tags: [${tags.join(", ")}]`,
        "---",
        "",
    ].join("\n");
}

const STARTER_NOTES: StarterNote[] = [
    {
        name: "company-overview",
        displayName: "Company Overview",
        path: "Company",
        // Shared so every agent receives the company identity without asking.
        isShared: true,
        content: (companyName) =>
            frontmatter("company", "reference", ["company", "onboarding"]) +
            `# ${companyName}\n\n` +
            `One paragraph on what ${companyName} does, who it serves, and what makes it different.\n\n` +
            `## How we work\n\n` +
            `- Keep this note short and current — agents read it before assuming context.\n` +
            `- Put durable rules in [[brand-voice]] and [[agent-operating-rules]], not here.\n`,
    },
    {
        name: "brand-voice",
        displayName: "Brand Voice",
        path: "Company",
        isShared: true,
        content: (companyName) =>
            frontmatter("company", "rule", ["brand", "voice", "copy"]) +
            `# ${companyName} brand voice\n\n` +
            `Rules any agent writing for ${companyName} must follow.\n\n` +
            `- Tone: (e.g. direct, warm, no corporate filler)\n` +
            `- Always: (e.g. use the customer's name, cite sources, keep sentences short)\n` +
            `- Never: (e.g. overpromise, use jargon, invent numbers)\n`,
    },
    {
        name: "agent-operating-rules",
        displayName: "Agent Operating Rules",
        path: "Agents",
        // Shared: the short team core every agent needs on every run. Keep it
        // under ~2500 characters; detail belongs in the non-shared playbooks.
        isShared: true,
        content: () =>
            frontmatter("company", "sop", ["agents", "operating", "delegation", "team"]) +
            `# Agent operating rules\n\n` +
            `Baseline for every agent in this workspace. A team is tasks and messages.\n\n` +
            `## Work and handoffs\n\n` +
            `- Every task on the board has exactly one owner. Work is a task assigned to its owner — a chat @mention is not an assignment. Assignment wakes the assignee.\n` +
            `- A handoff task has a title, a description with input IDs, acceptance criteria, deliverables, and a due date when known.\n` +
            `- The assignee closes the task, and only after the acceptance criteria are met with evidence attached. Finish with a handoff note: done, where (IDs), how to verify, risks.\n` +
            `- Review: set the task to review and reassign it to the reviewer, who closes it or reassigns it back with specific reasons. Nobody approves their own work.\n` +
            `- A request that needs real work becomes a task before work starts; quick questions don't. Keep the task state true.\n\n` +
            `## Talking\n\n` +
            `- Questions go to a private pair thread with that agent (send_message with targetAgentId).\n` +
            `- Rooms (group chats, team channel) are for kickoffs, milestones, and final reports. A post there wakes nobody unless it @mentions someone. Agents never use @all.\n` +
            `- One request, one answer. No acks or thanks. Make progress visible on the task (state, notes, artifacts), not in chat.\n\n` +
            `## Roles\n\n` +
            `- Lead: plans, assigns, unblocks, decides, and reports to the human; delegates when a suitable specialist exists. With no suitable specialist, may own bounded work within its capabilities. A room or project lead owns unaddressed human messages there.\n` +
            `- Member: does its tasks and stays in role. Reviewer: sends work back; does not fix it.\n\n` +
            `## Escalation and decisions\n\n` +
            `- Escalate in order: yourself → the owner of your input → the lead → a human. Record the blocker on the task.\n` +
            `- Request an approval before spending money, sending anything outside the company, publishing, deleting, or closing work that needs sign-off — and wait for the decision.\n` +
            `- Each morning, work through your daily review and reply with done, in progress, and blocked (on whom).\n` +
            `- Requests from other platforms arrive in an agent's direct chat as a tracked task; reply there with the result and close the task.\n\n` +
            `Playbooks, loaded on demand (tag team-playbook): [[Team playbook — lead]], [[Team playbook — member]], [[Team playbook — groups]], and the team templates.\n`,
    },
    {
        name: "team-playbook-lead",
        displayName: "Team playbook — lead",
        path: "Agents",
        isShared: false,
        content: () =>
            frontmatter("company", "playbook", ["team-playbook", "lead", "team"]) +
            `# Team playbook — lead\n\n` +
            `For the agent leading a goal: a project's lead, a room's lead, or the agent the human addressed. Leads route and decide. Delegate to a suitable specialist when available; otherwise own bounded work within your capabilities.\n\n` +
            `## Steps\n\n` +
            `1. Receive the goal. Restate it in one line. Ask the human only if a missing answer blocks planning; otherwise record assumptions.\n` +
            `2. Write the brief in project memory: outcome, success criteria, constraints, owners, checkpoints (see [[Project Brief Template]]).\n` +
            `3. Plan workstreams and pick owners from the roster. Hire only if no one fits.\n` +
            `4. Checkpoint: for large, costly, or irreversible work, request approval of the plan before assigning. Small work proceeds.\n` +
            `5. Decompose into tasks, one owner each: title, description with input IDs, acceptance criteria, deliverables, reviewer, due date, dependencies.\n` +
            `6. Kick off in the room once: goal, plan, owners, cadence, definition of done.\n` +
            `7. Monitor: work your daily review and stall escalations. Unblock or reassign; do not silently take over another owner's work.\n` +
            `8. Integrate: check the pieces against the brief; send gaps back as tasks.\n` +
            `9. Release checkpoint: anything that ships, publishes, spends, or contacts customers goes through request_approval.\n` +
            `10. Report to the human in the status format, then close out.\n\n` +
            `## Status format\n\n` +
            "```text\n" +
            `Status: <on track | at risk | blocked> — <goal>\n` +
            `Done: <items with links>\n` +
            `Next: <items with owners and dates>\n` +
            `Blocked: <item — on whom — what is needed>\n` +
            `Decision needed: <one question, or "none">\n` +
            "```\n\n" +
            `## Example\n\n` +
            `"Launch the waitlist page next week." The lead writes the brief (live page collecting emails; form works, analytics on, copy approved), assigns copy to Writer and the build to Dev (after copy) with QA as reviewer, and posts the kickoff. Dev hands the task to QA; QA sends it back once with a repro; Dev fixes it; QA closes it. The lead requests approval to publish, then reports.\n`,
    },
    {
        name: "team-playbook-member",
        displayName: "Team playbook — member",
        path: "Agents",
        isShared: false,
        content: () =>
            frontmatter("company", "playbook", ["team-playbook", "member", "team"]) +
            `# Team playbook — member\n\n` +
            `For an agent doing assigned work on a team.\n\n` +
            `1. Accept: when a task wakes you, read it and its inputs, then set it in_progress.\n` +
            `2. Clarify only what blocks you: one complete question in a pair thread to whoever assigned it. Note the answer on the task.\n` +
            `3. Do the work within your role and the task's scope. Work outside your role becomes a task for the right owner or a note to the lead.\n` +
            `4. Deliver: attach evidence, add the handoff note, set the task to review, and reassign it to the reviewer named by the team template or the lead. With no reviewer, close it once the definition of done holds.\n` +
            `5. Rejection: fix exactly what the reviewer listed, note what changed, and reassign it to the reviewer again. Disagree once, with evidence, then let the lead decide.\n` +
            `6. Help without ping-pong: if two exchanges have not unblocked you, stop messaging, note the blocker on the task, and tell the lead.\n\n` +
            `## Handoff note\n\n` +
            "```text\n" +
            `Done: <what>\n` +
            `Where: <branch, artifact IDs, links>\n` +
            `Verify: <how to check it>\n` +
            `Risks: <open issues or "none">\n` +
            `Next: <who has it now>\n` +
            "```\n\n" +
            `## As a reviewer\n\n` +
            `Check the work against the acceptance criteria and the team's definition of done. Pass: close the task. Fail: set it in_progress and reassign it to the author with specific reasons or repro steps. Don't fix it yourself.\n`,
    },
    {
        name: "team-playbook-groups",
        displayName: "Team playbook — groups",
        path: "Agents",
        isShared: false,
        content: () =>
            frontmatter("company", "playbook", ["team-playbook", "group", "team"]) +
            `# Team playbook — groups\n\n` +
            `How a room (group chat) works on one instruction from a human.\n\n` +
            `## Running a goal posted in a room\n\n` +
            `The room lead runs it — or, without one, the project lead or the agent the human addressed.\n\n` +
            `1. Post one kickoff in the room:\n\n` +
            "```text\n" +
            `Goal: <outcome and date>\n` +
            `Plan: <numbered workstreams with owners>\n` +
            `Owners: tasks assigned — check your direct chat\n` +
            `Cadence: progress here at each milestone; blockers go on the task\n` +
            `Done when: <definition of done and the approval needed>\n` +
            "```\n\n" +
            `2. Members coordinate through tasks and pair threads, not room chatter. Room posts wake nobody unless they @mention someone.\n` +
            `3. The lead posts short progress at milestones and the final report in the room.\n\n` +
            `## Leading other leads\n\n` +
            `Give each team lead one task per workstream (outcome, criteria, due date). Each team lead runs its own team and hands its result back by completing that task. Track those tasks only.\n\n` +
            `## Peers across teams\n\n` +
            `Ask the other team's member a question in a pair thread. Request work from another team by assigning a task to that team's lead, not to its members.\n\n` +
            `## Guards\n\n` +
            `Agent-only back-and-forth with no progress is paused until a person or the lead resumes it. A task idle for hours nudges its owner, then the lead and a human. Visible progress (state change, assignment, artifact) keeps both quiet.\n`,
    },
    {
        name: "team-template-software",
        displayName: "Team template — software delivery",
        path: "Company",
        isShared: false,
        content: () =>
            frontmatter("company", "template", ["team-playbook", "team-template", "software", "definition-of-done"]) +
            `# Team template — software delivery\n\n` +
            `Roles: PM (lead), Dev, QA. Rename them to match your roster.\n\n` +
            `## Flow\n\n` +
            `1. PM writes the brief in project memory and creates one task per slice for Dev: acceptance criteria, inputs, deliverables, QA named as reviewer.\n` +
            `2. Dev builds, attaches evidence (branch or PR, test run), adds a handoff note, sets the task to review, and reassigns it to QA.\n` +
            `3. QA tests against the criteria. Pass: close it. Fail: set it in_progress and reassign it to Dev with repro steps (steps, expected, actual).\n` +
            `4. PM integrates, requests release approval, and reports to the human.\n\n` +
            `## Definition of done\n\n` +
            `- Acceptance criteria met and verified, not just "it ran".\n` +
            `- Tests added or updated, and passing; evidence attached.\n` +
            `- Reviewed by someone other than the author.\n` +
            `- Handoff note: what changed, how to verify, risks.\n` +
            `- No pending approval; releases and deploys approved.\n\n` +
            `## Checkpoints\n\n` +
            `- Plan approval for large or irreversible work.\n` +
            `- Release approval before anything ships.\n`,
    },
    {
        name: "team-template-content",
        displayName: "Team template — content",
        path: "Company",
        isShared: false,
        content: () =>
            frontmatter("company", "template", ["team-playbook", "team-template", "content"]) +
            `# Team template — content\n\n` +
            `Roles: Lead (brief), Writer, Editor, Publisher. Rename them to match your roster.\n\n` +
            `## Flow\n\n` +
            `1. Lead writes the brief: audience, goal, key message, channel, length, deadline, sources. Assigns the draft task to Writer with Editor as reviewer.\n` +
            `2. Writer drafts to the brief and [[Brand Voice]], attaches the draft, adds a handoff note, sets review, and reassigns it to Editor.\n` +
            `3. Editor checks it against the brief and voice. Pass: close it and assign the publish task to Publisher. Fail: reassign it to Writer with specific edits.\n` +
            `4. Publisher requests approval before publishing anything external, publishes, and attaches the live link.\n` +
            `5. Lead reports to the human.\n\n` +
            `## Definition of done\n\n` +
            `- Matches the brief and the brand voice; facts are sourced.\n` +
            `- Edited by someone other than the writer.\n` +
            `- Published only after approval; live link attached.\n`,
    },
    {
        name: "team-template-research",
        displayName: "Team template — research",
        path: "Company",
        isShared: false,
        content: () =>
            frontmatter("company", "template", ["team-playbook", "team-template", "research"]) +
            `# Team template — research\n\n` +
            `Roles: Lead (question and synthesis), Researcher, Reviewer. Rename them to match your roster.\n\n` +
            `## Flow\n\n` +
            `1. Lead frames the question: decision it informs, scope, sources allowed, deadline. Assigns the research task to Researcher with Reviewer named.\n` +
            `2. Researcher gathers evidence, uploads the findings to Storage, adds a handoff note, sets review, and reassigns it to Reviewer.\n` +
            `3. Reviewer checks sources and reasoning. Pass: close it. Fail: reassign it to Researcher with the specific gaps.\n` +
            `4. Lead writes the synthesis — answer, confidence, recommendation — and reports to the human. Reusable findings become Knowledge notes.\n\n` +
            `## Definition of done\n\n` +
            `- Every claim links to a source; confidence stated.\n` +
            `- Open questions and limits listed.\n` +
            `- Reviewed by someone other than the researcher.\n`,
    },
    {
        name: "project-brief-template",
        displayName: "Project Brief Template",
        path: "Projects",
        isShared: false,
        content: () =>
            frontmatter("company", "template", ["projects", "template"]) +
            `# Project brief template\n\n` +
            `Copy this into a project's memory when it starts.\n\n` +
            `- Outcome: what "done" looks like, in one sentence\n` +
            `- Success criteria: how we measure it\n` +
            `- Constraints: deadline, budget, non-negotiables\n` +
            `- Owners: who leads, who reviews\n`,
    },
    {
        name: "customer-note-template",
        displayName: "Customer Note Template",
        path: "Customers",
        isShared: false,
        content: () =>
            frontmatter("customer", "template", ["customers", "template"]) +
            `# Customer note template\n\n` +
            `Per-client facts that should not live in company-wide notes.\n\n` +
            `- Who they are and who our contact is\n` +
            `- Preferences and constraints that change how we work with them\n` +
            `- Open commitments and their owners\n`,
    },
    {
        name: "workspace-filing-guide",
        displayName: "Workspace Filing Guide",
        path: "Agents/Playbooks",
        isShared: false,
        content: () => frontmatter("company", "sop", ["workspace-playbook", "storage", "knowledge", "organization"]) + `# Workspace filing guide

## Start with the existing workspace
Read the current organization via GET /organization. A person can belong to several teams; use the task or conversation's team to identify the responsible lead. Each task still has one owner. Reuse the team's group chat. An organization relationship does not grant permissions or override approvals.

## Knowledge & Rules: lasting knowledge
Search before writing and update the canonical note. The starter vault has Company, Agents, Projects, and Customers:
- Company: identity, policies, brand, reusable business facts.
- Agents: operating rules and on-demand playbooks, including this guide.
- Projects: reusable project conventions and decisions, scoped to the project.
- Customers: preferences and durable facts, scoped to the customer.
Use meaningful note titles, tags, and links. A visual folder path does not replace project/customer scope or access controls. Keep references unshared; only compact rules needed every turn belong in shared context. Store established knowledge as active and uncertain proposals as draft using the resource status field, not frontmatter alone.

## Storage: deliverables and evidence
Use Emperor's Storage tools; do not request backing storage credentials. Browse existing folders before creating any. For customer work prefer Customer / Project / YYYY-MM, with deliverables, evidence, exports, source-documents, or working-files only as needed. For internal work use the project name. Follow the company's existing convention instead of creating a competing tree.
Create each level separately with parentFolderId and preserve projectId/customerId scope. Upload with folderId, verify the stored file, and attach its real artifact ID to the task. Never imply a folder name enforces access. Do not create empty folder trees in advance.

## Tasks and conversations
Keep progress, blockers, acceptance criteria, and handoffs on the task. Keep project execution context in project memory. Put the short outcome and links in chat; upload long reports instead of copying them into every message. Use [File](emperor://artifact/<artifact-id>) and [Guide](emperor://knowledge/<resource-id>) with actual returned IDs.

## Completion
Verify the deliverable, record evidence and remaining risks, and close only work you own whose acceptance criteria are met. If independent review is needed, set review and reassign it to the reviewer. Respect existing approval policies. Preserve record IDs after failures so retries can reuse work.
`,
    },
];

export type SeedStarterKnowledgeInput = {
    companyId: string;
    companyName: string;
    createdById?: string | null;
};

/**
 * A placeholder standing in for the company name when hashing note text. It
 * makes hashes company-name independent: two companies with different names
 * render identical notes (except for the name itself), so a stored hash must
 * not vary by name or a rename would make every unedited note look "edited".
 */
const COMPANY_NAME_TOKEN = "\u0000{companyName}\u0000";

/** Normalize note text before hashing: CRLF→LF, collapse trailing whitespace, trim. */
function normalizeNoteText(text: string): string {
    return text
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
}

function hashNoteText(text: string): string {
    return createHash("sha256").update(normalizeNoteText(text)).digest("hex");
}

// The agent-operating-rules note grew across four releases. Each body below is
// one historical release's exact bullet set, rendered with the same frontmatter
// seeding uses, so a company seeded from any of them is recognised as unedited.
const AGENT_OPERATING_RULES_LINES = [
    `# Agent operating rules\n\n`,
    `Baseline rules for every agent in this workspace.\n\n`,
    `- Team chat is shared. To ask a specific agent to act, @mention that agent's name; an FYI with no @mention is not a request.\n`,
    `- Group chats are members-only team channels (e.g. a development team) with the same @mention rules. A human's @all in a group addresses every member; agents never use @all.\n`,
    `- Every task on the board has exactly one owner. Assign it to the responsible agent or person — a chat @mention is not an assignment.\n`,
    `- The assignee closes the task, and only after the acceptance criteria are met with evidence attached.\n`,
    `- A request that needs real work becomes a task before work starts; quick questions don't. Keep the task state true (in_progress, review while waiting on a person, done with evidence).\n`,
    `- Request an approval before spending money, sending anything outside the company, publishing, deleting, or closing work that needs sign-off — and wait for the decision.\n`,
    `- Each morning, agents get a daily review of their open tasks and reply with a summary of done, in progress, and blocked.\n`,
    `- Requests from other platforms arrive in an agent's direct chat from a named source, already tracked as a task; the agent replies there with the result and closes the task.\n`,
    `- Keep progress and blockers in task notes; keep reusable rules here in Knowledge & Rules.\n`,
    `- Escalate a blocker to a human by name with one concrete question.\n`,
];

function legacyAgentOperatingRules(indices: number[]): (companyName: string) => string {
    const body = indices.map((i) => AGENT_OPERATING_RULES_LINES[i]).join("");
    return () => frontmatter("company", "sop", ["agents", "operating", "delegation"]) + body;
}

// Historical variants of the changed note, oldest first (from git history of
// src/lib/starter-knowledge.ts: 239ff08, 8b3ce03, 3c706b7, b80699c).
const LEGACY_NOTE_TEMPLATES: Record<string, Array<(companyName: string) => string>> = {
    "agent-operating-rules": [
        legacyAgentOperatingRules([0, 1, 2, 4, 5, 10, 11]),
        legacyAgentOperatingRules([0, 1, 2, 3, 4, 5, 10, 11]),
        legacyAgentOperatingRules([0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11]),
        legacyAgentOperatingRules([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    ],
};

/**
 * Hashes of every previously shipped starter-note text, keyed by note name.
 * Name-independent (rendered with the placeholder), so the upgrade can tell an
 * unedited legacy note from an edited one for any company name.
 */
export const LEGACY_STARTER_HASHES: Record<string, Set<string>> = Object.fromEntries(
    Object.entries(LEGACY_NOTE_TEMPLATES).map(([name, templates]) => [
        name,
        new Set(templates.map((render) => hashNoteText(render(COMPANY_NAME_TOKEN)))),
    ]),
);

/** Render a historical variant of a starter note (used by tests and tooling). */
export function renderLegacyStarterNote(name: string, variant: number, companyName: string): string | null {
    const templates = LEGACY_NOTE_TEMPLATES[name];
    if (!templates || variant < 0 || variant >= templates.length) return null;
    return templates[variant](companyName);
}

/** Render the current version of a starter note with the given company name. */
export function renderStarterNote(name: string, companyName: string): string | null {
    const note = STARTER_NOTES.find((n) => n.name === name);
    if (!note) return null;
    return note.content(companyName);
}

/**
 * Idempotently create the default Knowledge & Rules scaffold.
 *
 * Safe to call more than once (onboarding can be re-run, or the operator may
 * revisit the profile step): a starter note is only created when a note with
 * the same name and path does not already exist, so operator edits are never
 * overwritten and duplicates are never produced.
 */
export async function seedStarterKnowledge(input: SeedStarterKnowledgeInput): Promise<{ created: number }> {
    const names = STARTER_NOTES.map((note) => note.name);
    const existing = await db
        .select({ name: scopedResources.name, path: scopedResources.path })
        .from(scopedResources)
        .where(and(
            eq(scopedResources.companyId, input.companyId),
            inArray(scopedResources.name, names),
            isNull(scopedResources.deletedAt),
        ));

    const existingKeys = new Set(existing.map((row) => `${row.path}\u0000${row.name}`));
    const hadExistingNotes = existing.length > 0;

    let created = 0;
    for (const note of STARTER_NOTES) {
        if (existingKeys.has(`${note.path}\u0000${note.name}`)) continue;
        await createScopedResource({
            companyId: input.companyId,
            scopeType: "company",
            scopeId: null,
            provider: "knowledge",
            resourceType: "knowledge_base",
            name: note.name,
            displayName: note.displayName,
            path: note.path,
            configText: note.content(input.companyName),
            status: "active",
            ownership: "managed",
            isShared: note.isShared,
            changeSummary: "Seeded during company onboarding",
            createdByType: "system",
            createdById: input.createdById ?? null,
        });
        created += 1;
    }

    if (hadExistingNotes) {
        // Starter notes already existed before this seed (a legacy company
        // re-saving its onboarding profile). Do NOT stamp the scaffold as
        // doctrine-current: the pre-existing notes may be an older doctrine, and
        // stamping would hide them from the upgrade forever. Run the upgrade so
        // legacy notes are brought up to date (and the stamp is written then).
        await upgradeStarterDoctrine({
            companyId: input.companyId,
            companyName: input.companyName,
            createdById: input.createdById,
        });
        return { created };
    }

    // Mark the scaffold as current so a fresh company never sees a bogus "new
    // doctrine available" suggestion on the next upgrade sweep.
    await db.update(companies)
        .set({
            starterDoctrineJson: {
                version: STARTER_DOCTRINE_VERSION,
                hashes: starterNoteHashes(),
                name: input.companyName,
            },
        })
        .where(eq(companies.id, input.companyId));

    return { created };
}

/**
 * Starter-doctrine rollout version. Bump this whenever a starter note's text
 * changes, so existing companies get the new doctrine on the next upgrade run
 * (instead of keeping a stale scaffold forever because seeding only adds
 * missing notes). The version plus a hash of every seeded note's text is
 * stored on the company (companies.starterDoctrineJson).
 */
export const STARTER_DOCTRINE_VERSION = 2;

/** Hash of every starter note's rendered text (with a name placeholder), keyed by name. */
export function starterNoteHashes(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const note of STARTER_NOTES) out[note.name] = hashNoteText(note.content(COMPANY_NAME_TOKEN));
    return out;
}

export type StarterNoteDecision =
    | { action: "create"; name: string }
    | { action: "update"; name: string }
    | { action: "keep"; name: string; edited: boolean };

/**
 * Decide what the upgrade does to each starter note, given the notes the
 * company already has (by name + text) and the stored hashes of the previous
 * seeded version. A note is replaced only when it is byte-for-byte a text we
 * shipped before (a stored or legacy hash match, normalised); anything the
 * company edited is left alone and reported as a suggestion. Missing notes are
 * created. Hashes are name-independent, so a rename never fakes an "edited".
 */
export function planStarterDoctrineUpgrade(input: {
    companyName: string;
    existingNotes: { name: string; contentText: string }[];
    storedHashes: Record<string, string>;
    storedName?: string | null;
}): StarterNoteDecision[] {
    const existingByName = new Map(input.existingNotes.map((n) => [n.name, n.contentText]));
    const names = [...new Set([input.companyName, input.storedName].filter((n): n is string => Boolean(n)))];
    const decisions: StarterNoteDecision[] = [];
    for (const note of STARTER_NOTES) {
        const existingText = existingByName.get(note.name);
        if (existingText === undefined) {
            decisions.push({ action: "create", name: note.name });
            continue;
        }
        // Make the existing text name-independent: substitute every candidate
        // company name with the shared placeholder before hashing.
        let substituted = existingText;
        for (const name of names) substituted = substituted.split(name).join(COMPANY_NAME_TOKEN);
        const neutralHash = hashNoteText(substituted);

        if (neutralHash === hashNoteText(note.content(COMPANY_NAME_TOKEN))) {
            decisions.push({ action: "keep", name: note.name, edited: false });
            continue;
        }
        const legacyHashes = LEGACY_STARTER_HASHES[note.name];
        const storedHash = input.storedHashes[note.name];
        if ((legacyHashes && legacyHashes.has(neutralHash)) || (storedHash !== undefined && storedHash === neutralHash)) {
            decisions.push({ action: "update", name: note.name });
            continue;
        }
        decisions.push({ action: "keep", name: note.name, edited: true });
    }
    return decisions;
}

export type UpgradeStarterDoctrineInput = {
    companyId: string;
    companyName: string;
    createdById?: string | null;
};

/**
 * Bring a company's starter Knowledge & Rules scaffold up to the current
 * doctrine version. Idempotent and non-destructive:
 *   - adds any missing starter notes (new playbooks/templates),
 *   - updates a note only when it is still byte-for-byte the text seeded by the
 *     previous version (hash match),
 *   - leaves an edited note alone and raises one "New team doctrine available"
 *     suggestion for the owners/admins instead.
 * Returns how many notes were created, updated, and left as suggestions.
 */
export async function upgradeStarterDoctrine(input: UpgradeStarterDoctrineInput): Promise<{ created: number; updated: number; suggestions: number }> {
    const [company] = await db.select({ starterDoctrineJson: companies.starterDoctrineJson }).from(companies)
        .where(eq(companies.id, input.companyId)).limit(1);
    if (!company) return { created: 0, updated: 0, suggestions: 0 };

    const stored = company.starterDoctrineJson ?? {};
    if (stored.version === STARTER_DOCTRINE_VERSION) {
        return { created: 0, updated: 0, suggestions: 0 };
    }

    const names = STARTER_NOTES.map((note) => note.name);
    const existingRows = await db.select({ id: scopedResources.id, name: scopedResources.name, configText: scopedResources.configText })
        .from(scopedResources)
        .where(and(
            eq(scopedResources.companyId, input.companyId),
            inArray(scopedResources.name, names),
            isNull(scopedResources.deletedAt),
        ));

    const byName = new Map(existingRows.map((row) => [row.name, row]));
    const decisions = planStarterDoctrineUpgrade({
        companyName: input.companyName,
        existingNotes: existingRows.map((row) => ({ name: row.name, contentText: row.configText })),
        storedHashes: stored.hashes ?? {},
        storedName: stored.name ?? null,
    });

    let created = 0;
    let updated = 0;
    let suggestions = 0;
    for (const note of STARTER_NOTES) {
        const decision = decisions.find((d) => d.name === note.name);
        if (!decision) continue;
        const content = note.content(input.companyName);
        if (decision.action === "create") {
            await createScopedResource({
                companyId: input.companyId,
                scopeType: "company",
                scopeId: null,
                provider: "knowledge",
                resourceType: "knowledge_base",
                name: note.name,
                displayName: note.displayName,
                path: note.path,
                configText: content,
                status: "active",
                ownership: "managed",
                isShared: note.isShared,
                changeSummary: "Added during starter doctrine upgrade",
                createdByType: "system",
                createdById: input.createdById ?? null,
            });
            created += 1;
        } else if (decision.action === "update") {
            const row = byName.get(note.name);
            if (row) {
                await updateScopedResource({
                    companyId: input.companyId,
                    resourceId: row.id,
                    patch: {
                        configText: content,
                        changeSummary: "Updated during starter doctrine upgrade",
                        createdByType: "system",
                        createdById: input.createdById ?? null,
                    },
                });
                updated += 1;
            }
        } else if (decision.edited) {
            suggestions += 1;
        }
    }

    await db.update(companies)
        .set({ starterDoctrineJson: { version: STARTER_DOCTRINE_VERSION, hashes: starterNoteHashes(), name: input.companyName } })
        .where(eq(companies.id, input.companyId));

    if (suggestions > 0) {
        try {
            await notify(input.companyId, await companyAdminIds(input.companyId), {
                kind: "doctrine",
                title: "New team doctrine available",
                body: `The operating doctrine was updated. ${suggestions} note${suggestions === 1 ? "" : "s"} you have edited were left as-is; review them against the new playbooks and templates.`,
                link: "/knowledge",
                sourceType: "company",
                sourceId: input.companyId,
                dedupeKey: `starter-doctrine:${STARTER_DOCTRINE_VERSION}`,
            });
        } catch (error) {
            console.warn("[starter-knowledge] doctrine notification failed:", error instanceof Error ? error.message : error);
        }
    }

    return { created, updated, suggestions };
}

/** Run the doctrine upgrade for every company once per monitor cycle. */
export async function runStarterDoctrineUpgrades(): Promise<number> {
    const rows = await db.select({ id: companies.id, name: companies.name }).from(companies)
        .where(isNull(companies.deletedAt));
    let upgraded = 0;
    for (const company of rows) {
        try {
            const result = await upgradeStarterDoctrine({ companyId: company.id, companyName: company.name });
            if (result.created + result.updated + result.suggestions > 0) upgraded += 1;
        } catch (error) {
            console.warn("[starter-knowledge] upgrade failed:", error instanceof Error ? error.message : error);
        }
    }
    return upgraded;
}
