import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ projectId: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { projectId } = await params;
    const endpoint = `/mcp/projects/${projectId}`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const body = await req.json();
        const { status: newStatus } = body;

        if (!newStatus) {
            return NextResponse.json({ error: "status is required" }, { status: 400 });
        }

        const validStatuses = ["active", "paused", "killed", "completed"];
        if (!validStatuses.includes(newStatus)) {
            return NextResponse.json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` }, { status: 400 });
        }

        const [existing] = await db.select().from(projects).where(
            and(eq(projects.id, projectId), eq(projects.companyId, companyId), isNull(projects.deletedAt))
        ).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Project not found or unauthorized." }, { status: 404 });
        }

        const [project] = await db.update(projects).set({
            status: newStatus,
            // Assuming we added an updatedAt field to the DB at some point, 
            // but schema.ts currently lacks it for `projects`, so we'll omit it.
        }).where(eq(projects.id, projectId)).returning();

        const res = { message: `Project status updated to ${newStatus}`, project };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        console.error(`Error updating project ${projectId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
