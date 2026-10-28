import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents, customers, projects } from "@/db/schema";
import { getCompanyId } from "@/lib/auth";
import { companyRouteAccess } from "@/lib/company-access";
import { memberMaySeeCustomer, memberProjectCondition } from "@/lib/member-scope";
import { memberMayUseAgent } from "@/lib/agent-access-server";
import { resourceWriteDenied } from "@/lib/resource-access";
import { prepareProjectGoal, saveProjectPurposeNote } from "@/lib/projects-crud";
import { humanActor, recordProjectAudit } from "@/lib/audit";

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

export async function GET() {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;

    const rows = await db.select({ id: projects.id, goal: projects.goal, customerId: projects.customerId })
        .from(projects)
        .where(and(eq(projects.companyId, companyId), isNull(projects.deletedAt), memberProjectCondition(access.ctx.scope, { id: projects.id, customerId: projects.customerId })))
        .orderBy(desc(projects.createdAt));

    return NextResponse.json({ projects: rows });
}

export async function POST(req: NextRequest) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;

    try {
        const body = await req.json();
        // A project under a customer needs edit access to that customer (0.20:
        // a company viewer with "Can edit" there may add one); an internal
        // project needs the company role.
        const denied = await resourceWriteDenied(access.ctx, typeof body.customerId === "string" && body.customerId ? { type: "customer", id: body.customerId } : null, "member", "Customer");
        if (denied) return denied;
        // Overlong names become a short name plus a purpose note (lib/project-title.ts).
        const prepared = prepareProjectGoal(body.goal, body.description);
        if (!prepared) {
            return NextResponse.json({ error: "goal is required" }, { status: 400 });
        }
        const goal = prepared.goal;
        if (!(await validateScopedRelation(companyId, customers, body.customerId))
            || (access.ctx.scope && !memberMaySeeCustomer(access.ctx.scope, body.customerId))) {
            return NextResponse.json({ error: "Customer not found" }, { status: 404 });
        }
        if (!(await validateScopedRelation(companyId, agents, body.leadAgentId))
            || (body.leadAgentId && !(await memberMayUseAgent(access.ctx, body.leadAgentId)))) {
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
        await saveProjectPurposeNote({ companyId, projectId: project.id, purpose: prepared.purpose });
        await recordProjectAudit(companyId, humanActor(access.ctx.userId), "project.created", project);

        return NextResponse.json({ project }, { status: 201 });
    } catch (error) {
        console.error("Project create error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
