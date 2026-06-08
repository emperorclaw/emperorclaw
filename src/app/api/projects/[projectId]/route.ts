import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents, customers, projects } from "@/db/schema";
import { getCompanyId } from "@/lib/auth";

const validStatuses = new Set(["active", "paused", "killed", "completed"]);

async function validateScopedRelation(companyId: string, table: typeof customers | typeof agents, id?: unknown) {
    if (!id) return true;
    if (typeof id !== "string") return false;
    const [row] = await db.select({ id: table.id }).from(table).where(and(
        eq(table.id, id),
        eq(table.companyId, companyId),
        isNull(table.deletedAt),
    )).limit(1);
    return Boolean(row);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
    const companyId = await getCompanyId();
    if (!companyId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { projectId } = await params;
    try {
        const body = await req.json();
        const [existing] = await db.select().from(projects).where(and(
            eq(projects.id, projectId),
            eq(projects.companyId, companyId),
            isNull(projects.deletedAt),
        )).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Project not found" }, { status: 404 });
        }

        const nextStatus = body.status === undefined ? existing.status : String(body.status);
        if (!validStatuses.has(nextStatus)) {
            return NextResponse.json({ error: "Invalid project status" }, { status: 400 });
        }

        const goal = typeof body.goal === "string" ? body.goal.trim() : existing.goal;
        if (!goal) {
            return NextResponse.json({ error: "goal is required" }, { status: 400 });
        }
        if (!(await validateScopedRelation(companyId, customers, body.customerId))) {
            return NextResponse.json({ error: "Customer not found" }, { status: 404 });
        }
        if (!(await validateScopedRelation(companyId, agents, body.leadAgentId))) {
            return NextResponse.json({ error: "Lead agent not found" }, { status: 404 });
        }

        const [project] = await db.update(projects).set({
            status: nextStatus,
            goal,
            customerId: body.customerId === undefined ? existing.customerId : (body.customerId || null),
            leadAgentId: body.leadAgentId === undefined ? existing.leadAgentId : (body.leadAgentId || null),
            requireApprovalForDone: body.requireApprovalForDone === undefined ? existing.requireApprovalForDone : Boolean(body.requireApprovalForDone),
            requireReviewBeforeDone: body.requireReviewBeforeDone === undefined ? existing.requireReviewBeforeDone : Boolean(body.requireReviewBeforeDone),
            commentRequiredForReview: body.commentRequiredForReview === undefined ? existing.commentRequiredForReview : Boolean(body.commentRequiredForReview),
            blockStatusChangesWithPendingApproval: body.blockStatusChangesWithPendingApproval === undefined ? existing.blockStatusChangesWithPendingApproval : Boolean(body.blockStatusChangesWithPendingApproval),
            onlyLeadCanChangeStatus: body.onlyLeadCanChangeStatus === undefined ? existing.onlyLeadCanChangeStatus : Boolean(body.onlyLeadCanChangeStatus),
            maxActiveAgents: body.maxActiveAgents === undefined ? existing.maxActiveAgents : Math.max(1, Number(body.maxActiveAgents) || existing.maxActiveAgents),
            updatedAt: new Date(),
        }).where(eq(projects.id, projectId)).returning();

        return NextResponse.json({ project });
    } catch (error) {
        console.error("Project update error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
    const companyId = await getCompanyId();
    if (!companyId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { projectId } = await params;
    try {
        const [existing] = await db.select().from(projects).where(and(
            eq(projects.id, projectId),
            eq(projects.companyId, companyId),
            isNull(projects.deletedAt),
        )).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Project not found" }, { status: 404 });
        }

        const [project] = await db.update(projects).set({
            deletedAt: new Date(),
            updatedAt: new Date(),
        }).where(eq(projects.id, projectId)).returning();

        return NextResponse.json({ project });
    } catch (error) {
        console.error("Project delete error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
