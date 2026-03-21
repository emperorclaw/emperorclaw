import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { db } from "@/db";
import { projects, customers } from "@/db/schema";
import { randomUUID } from "crypto";
import { and, desc, eq, isNull } from "drizzle-orm";

export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 500);
    const status = searchParams.get("status");

    try {
        const conditions = [
            eq(projects.companyId, companyId),
            isNull(projects.deletedAt),
        ];
        if (status) {
            conditions.push(eq(projects.status, status));
        }

        const rows = await db.select({
            project: projects,
            customer: customers,
        }).from(projects)
            .leftJoin(customers, eq(projects.customerId, customers.id))
            .where(and(...conditions))
            .orderBy(desc(projects.createdAt))
            .limit(limit);

        const result = rows.map((r) => ({
            ...r.project,
            customer: r.customer || null,
        }));

        return NextResponse.json({ projects: result });
    } catch (err) {
        console.error("Error fetching projects:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const endpoint = "/api/mcp/projects";

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const body = await req.json();
        const {
            customerId,
            goal,
            status: projectStatus,
            leadAgentId = null,
            requireApprovalForDone = false,
            requireReviewBeforeDone = false,
            commentRequiredForReview = false,
            blockStatusChangesWithPendingApproval = false,
            onlyLeadCanChangeStatus = false,
            maxActiveAgents = 3,
        } = body;

        if (!goal) {
            return NextResponse.json({ error: "goal is required" }, { status: 400 });
        }

        const [project] = await db.insert(projects).values({
            id: randomUUID(),
            companyId,
            customerId: customerId || null,
            goal,
            leadAgentId,
            status: projectStatus || "active",
            requireApprovalForDone: Boolean(requireApprovalForDone),
            requireReviewBeforeDone: Boolean(requireReviewBeforeDone),
            commentRequiredForReview: Boolean(commentRequiredForReview),
            blockStatusChangesWithPendingApproval: Boolean(blockStatusChangesWithPendingApproval),
            onlyLeadCanChangeStatus: Boolean(onlyLeadCanChangeStatus),
            maxActiveAgents: Math.max(1, Number(maxActiveAgents) || 3),
        }).returning();

        const res = { message: "Project created", project };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 201 });
    } catch (err) {
        console.error("Error creating project:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
