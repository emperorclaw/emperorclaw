import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { scopedResources } from "@/db/schema";
import { createScopedResource } from "@/lib/resources";

/**
 * Default Knowledge & Rules scaffold created for a brand-new company.
 *
 * Folders in Knowledge & Rules are implicit — they exist only because a note
 * lives at that path — so the scaffold ships one starter note per top-level
 * folder rather than a folder table. The four folders match how the operating
 * doctrine already tells agents to scope knowledge: company-wide rules,
 * agent operating instructions, project conventions, and client facts.
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
        // Shared: this is exactly the kind of short, repeatedly-needed rule the
        // auto-injection budget is for.
        isShared: true,
        content: () =>
            frontmatter("company", "sop", ["agents", "operating", "delegation"]) +
            `# Agent operating rules\n\n` +
            `Baseline rules for every agent in this workspace.\n\n` +
            `- Team chat is shared. To ask a specific agent to act, @mention that agent's name; an FYI with no @mention is not a request.\n` +
            `- Every task on the board has exactly one owner. Assign it to the responsible agent or person — a chat @mention is not an assignment.\n` +
            `- The assignee closes the task, and only after the acceptance criteria are met with evidence attached.\n` +
            `- Keep progress and blockers in task notes; keep reusable rules here in Knowledge & Rules.\n` +
            `- Escalate a blocker to a human by name with one concrete question.\n`,
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
];

export type SeedStarterKnowledgeInput = {
    companyId: string;
    companyName: string;
    createdById?: string | null;
};

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

    return { created };
}
