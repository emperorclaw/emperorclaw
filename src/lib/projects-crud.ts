import { db } from "@/db";
import { projects, customers, projectMemory } from "@/db/schema";
import { randomUUID } from "crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { scopeCondition } from "@/lib/agent-scope";
import { normalizeProjectInput } from "@/lib/project-title";

/**
 * Project names are short labels (PROJECT_NAME_MAX). An overlong goal is split
 * into a short name and a purpose; the projects table has no description
 * column yet, so the purpose is kept as a project note (project memory),
 * where agents and people already look for project context.
 */
export function prepareProjectGoal(goal: unknown, description?: unknown): { goal: string; purpose: string | null; autoSplit: boolean } | null {
    const normalized = normalizeProjectInput({ name: goal, description }, { mode: "split" });
    if (!normalized.ok) return null;
    return { goal: normalized.name, purpose: normalized.description, autoSplit: normalized.autoSplit };
}

/** Longest project purpose kept; longer text is cut, like an overlong name is split. */
export const PROJECT_PURPOSE_MAX = 4000;

const PROJECT_PURPOSE_TAG = "project-purpose";

export async function saveProjectPurposeNote(input: { companyId: string; projectId: string; purpose: string | null; createdByAgentId?: string | null }) {
    let purpose = input.purpose?.trim();
    if (!purpose) return;
    if (purpose.length > PROJECT_PURPOSE_MAX) purpose = `${purpose.slice(0, PROJECT_PURPOSE_MAX - 1).trimEnd()}…`;
    const content = `**Purpose**

${purpose}`;
    // Re-saving the same purpose (an edit that only renames, a retried call)
    // must not stack identical notes.
    const [latest] = await db.select({ content: projectMemory.content }).from(projectMemory)
        .where(and(
            eq(projectMemory.companyId, input.companyId),
            eq(projectMemory.projectId, input.projectId),
            sql`${projectMemory.tags} @> ${JSON.stringify([PROJECT_PURPOSE_TAG])}::jsonb`,
        ))
        .orderBy(desc(projectMemory.createdAt), desc(projectMemory.id))
        .limit(1);
    if (latest?.content === content) return;
    await db.insert(projectMemory).values({
        companyId: input.companyId,
        projectId: input.projectId,
        content,
        tags: [PROJECT_PURPOSE_TAG],
        createdByAgentId: input.createdByAgentId ?? null,
    });
}

export type ListProjectsInput = {
    companyId: string;
    status?: string | null;
    limit?: number;
    // null/undefined = unrestricted; a Set (possibly empty) restricts to those project ids.
    // Comes from an agent's scope — see src/lib/agent-scope.ts.
    projectIdFilter?: Set<string> | null;
};

export async function listProjectsForCompany(input: ListProjectsInput) {
    const limit = Math.min(input.limit || 100, 500);
    const conditions = [
        eq(projects.companyId, input.companyId),
        isNull(projects.deletedAt),
    ];
    if (input.status) {
        conditions.push(eq(projects.status, input.status));
    }
    const scoped = scopeCondition(input.projectIdFilter ?? null, projects.id);
    if (scoped) conditions.push(scoped);

    const rows = await db.select({
        project: projects,
        customer: customers,
    }).from(projects)
        .leftJoin(customers, eq(projects.customerId, customers.id))
        .where(and(...conditions))
        .orderBy(desc(projects.createdAt))
        .limit(limit);

    return rows.map((r) => ({ ...r.project, customer: r.customer || null }));
}

export async function getProjectForCompany(companyId: string, projectId: string) {
    const [row] = await db.select({
        project: projects,
        customer: customers,
    }).from(projects)
        .leftJoin(customers, eq(projects.customerId, customers.id))
        .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId), isNull(projects.deletedAt)))
        .limit(1);
    if (!row) return null;
    return { ...row.project, customer: row.customer || null };
}

export type CreateProjectInput = {
    companyId: string;
    customerId?: string | null;
    goal: string;
    /** What the project is for. Stored as a project note until projects get a description column. */
    description?: string | null;
    createdByAgentId?: string | null;
    status?: string;
    leadAgentId?: string | null;
    requireApprovalForDone?: boolean;
    requireReviewBeforeDone?: boolean;
    commentRequiredForReview?: boolean;
    blockStatusChangesWithPendingApproval?: boolean;
    onlyLeadCanChangeStatus?: boolean;
    maxActiveAgents?: number;
};

export async function createProjectForCompany(input: CreateProjectInput) {
    const prepared = prepareProjectGoal(input.goal, input.description);
    if (!prepared) {
        throw new Error("GOAL_REQUIRED");
    }

    const [project] = await db.insert(projects).values({
        id: randomUUID(),
        companyId: input.companyId,
        customerId: input.customerId || null,
        goal: prepared.goal,
        leadAgentId: input.leadAgentId || null,
        status: input.status || "active",
        requireApprovalForDone: Boolean(input.requireApprovalForDone),
        requireReviewBeforeDone: Boolean(input.requireReviewBeforeDone),
        commentRequiredForReview: Boolean(input.commentRequiredForReview),
        blockStatusChangesWithPendingApproval: Boolean(input.blockStatusChangesWithPendingApproval),
        onlyLeadCanChangeStatus: Boolean(input.onlyLeadCanChangeStatus),
        maxActiveAgents: Math.max(1, Number(input.maxActiveAgents) || 3),
    }).returning();

    await saveProjectPurposeNote({ companyId: input.companyId, projectId: project.id, purpose: prepared.purpose, createdByAgentId: input.createdByAgentId });
    await broadcastMcpEvent(input.companyId, { type: "project_created", project });
    return project;
}

const VALID_PROJECT_STATUSES = ["active", "paused", "killed", "completed"];

export type UpdateProjectInput = {
    companyId: string;
    projectId: string;
    status?: string;
    goal?: string;
    description?: string | null;
    createdByAgentId?: string | null;
    customerId?: string | null;
    leadAgentId?: string | null;
    requireApprovalForDone?: boolean;
    requireReviewBeforeDone?: boolean;
    commentRequiredForReview?: boolean;
    blockStatusChangesWithPendingApproval?: boolean;
    onlyLeadCanChangeStatus?: boolean;
    maxActiveAgents?: number;
};

export async function updateProjectForCompany(input: UpdateProjectInput) {
    if (input.status && !VALID_PROJECT_STATUSES.includes(input.status)) {
        throw new Error(`INVALID_STATUS: must be one of ${VALID_PROJECT_STATUSES.join(", ")}`);
    }

    const [existing] = await db.select().from(projects).where(
        and(eq(projects.id, input.projectId), eq(projects.companyId, input.companyId), isNull(projects.deletedAt))
    ).limit(1);

    if (!existing) {
        throw new Error("PROJECT_NOT_FOUND");
    }

    // A rename goes through the same short-name rule as create; an explicit
    // description alone is saved as a purpose note.
    const renamed = input.goal === undefined ? null : prepareProjectGoal(input.goal, input.description);
    if (input.goal !== undefined && !renamed) throw new Error("GOAL_REQUIRED");
    const purpose = renamed ? renamed.purpose : (typeof input.description === "string" && input.description.trim() ? input.description.trim() : null);

    const [project] = await db.update(projects).set({
        status: input.status ?? existing.status,
        goal: renamed?.goal ?? existing.goal,
        customerId: input.customerId === undefined ? existing.customerId : (input.customerId || null),
        leadAgentId: input.leadAgentId === undefined ? existing.leadAgentId : (input.leadAgentId || null),
        requireApprovalForDone: input.requireApprovalForDone === undefined ? existing.requireApprovalForDone : Boolean(input.requireApprovalForDone),
        requireReviewBeforeDone: input.requireReviewBeforeDone === undefined ? existing.requireReviewBeforeDone : Boolean(input.requireReviewBeforeDone),
        commentRequiredForReview: input.commentRequiredForReview === undefined ? existing.commentRequiredForReview : Boolean(input.commentRequiredForReview),
        blockStatusChangesWithPendingApproval: input.blockStatusChangesWithPendingApproval === undefined ? existing.blockStatusChangesWithPendingApproval : Boolean(input.blockStatusChangesWithPendingApproval),
        onlyLeadCanChangeStatus: input.onlyLeadCanChangeStatus === undefined ? existing.onlyLeadCanChangeStatus : Boolean(input.onlyLeadCanChangeStatus),
        maxActiveAgents: input.maxActiveAgents === undefined ? existing.maxActiveAgents : Math.max(1, Number(input.maxActiveAgents) || existing.maxActiveAgents),
        updatedAt: new Date(),
    }).where(eq(projects.id, input.projectId)).returning();

    await saveProjectPurposeNote({ companyId: input.companyId, projectId: project.id, purpose, createdByAgentId: input.createdByAgentId });
    await broadcastMcpEvent(input.companyId, { type: "project_updated", project });
    return project;
}
