import { db } from "@/db";
import { projects, customers } from "@/db/schema";
import { randomUUID } from "crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { broadcastMcpEvent } from "@/lib/pubsub";

export type ListProjectsInput = {
    companyId: string;
    status?: string | null;
    limit?: number;
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
    if (!input.goal) {
        throw new Error("GOAL_REQUIRED");
    }

    const [project] = await db.insert(projects).values({
        id: randomUUID(),
        companyId: input.companyId,
        customerId: input.customerId || null,
        goal: input.goal,
        leadAgentId: input.leadAgentId || null,
        status: input.status || "active",
        requireApprovalForDone: Boolean(input.requireApprovalForDone),
        requireReviewBeforeDone: Boolean(input.requireReviewBeforeDone),
        commentRequiredForReview: Boolean(input.commentRequiredForReview),
        blockStatusChangesWithPendingApproval: Boolean(input.blockStatusChangesWithPendingApproval),
        onlyLeadCanChangeStatus: Boolean(input.onlyLeadCanChangeStatus),
        maxActiveAgents: Math.max(1, Number(input.maxActiveAgents) || 3),
    }).returning();

    await broadcastMcpEvent(input.companyId, { type: "project_created", project });
    return project;
}

const VALID_PROJECT_STATUSES = ["active", "paused", "killed", "completed"];

export type UpdateProjectInput = {
    companyId: string;
    projectId: string;
    status?: string;
    goal?: string;
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

    const [project] = await db.update(projects).set({
        status: input.status ?? existing.status,
        goal: input.goal ?? existing.goal,
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

    await broadcastMcpEvent(input.companyId, { type: "project_updated", project });
    return project;
}
