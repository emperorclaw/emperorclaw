import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents, customers, projects } from "@/db/schema";
import { getCompanyId } from "@/lib/auth";

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

export async function POST(req: NextRequest) {
    const companyId = await getCompanyId();
    if (!companyId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const body = await req.json();
        const goal = typeof body.goal === "string" ? body.goal.trim() : "";
        if (!goal) {
            return NextResponse.json({ error: "goal is required" }, { status: 400 });
        }
        if (!(await validateScopedRelation(companyId, customers, body.customerId))) {
            return NextResponse.json({ error: "Customer not found" }, { status: 404 });
        }
        if (!(await validateScopedRelation(companyId, agents, body.leadAgentId))) {
            return NextResponse.json({ error: "Lead agent not found" }, { status: 404 });
        }

        const [project] = await db.insert(projects).values({
            id: randomUUID(),
            companyId,
            customerId: body.customerId || null,
            leadAgentId: body.leadAgentId || null,
            goal,
            status: body.status || "active",
            requireApprovalForDone: Boolean(body.requireApprovalForDone),
            requireReviewBeforeDone: Boolean(body.requireReviewBeforeDone),
            commentRequiredForReview: Boolean(body.commentRequiredForReview),
            blockStatusChangesWithPendingApproval: Boolean(body.blockStatusChangesWithPendingApproval),
            onlyLeadCanChangeStatus: Boolean(body.onlyLeadCanChangeStatus),
            maxActiveAgents: Math.max(1, Number(body.maxActiveAgents) || 3),
        }).returning();

        return NextResponse.json({ project }, { status: 201 });
    } catch (error) {
        console.error("Project create error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
