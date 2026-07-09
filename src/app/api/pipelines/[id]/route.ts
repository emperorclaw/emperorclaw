export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getValidatedServerSession } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers, pipelines } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { validateForActivation, PIPELINE_STATUSES, PipelineStatus } from "@/lib/pipelines";

async function getMembership() {
    const session = await getValidatedServerSession();
    const sessionUserId = session?.user?.id;
    if (!sessionUserId) {
        return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    }

    const [membership] = await db.select().from(companyMembers)
        .where(eq(companyMembers.userId, sessionUserId))
        .limit(1);
    if (!membership) {
        return { error: NextResponse.json({ error: "Company not found" }, { status: 404 }) };
    }

    return { membership };
}

// PATCH /api/pipelines/[id] - UI status changes: pause / activate / retire.
export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const auth = await getMembership();
        if (auth.error) return auth.error;
        const membership = auth.membership;

        const { id } = await params;
        const body = await req.json();
        const status = body.status as string | undefined;

        if (!status || !PIPELINE_STATUSES.includes(status as PipelineStatus)) {
            return NextResponse.json({ error: `status must be one of: ${PIPELINE_STATUSES.join(", ")}` }, { status: 400 });
        }

        const [pipeline] = await db.select().from(pipelines).where(
            and(eq(pipelines.id, id), eq(pipelines.companyId, membership.companyId), isNull(pipelines.deletedAt))
        ).limit(1);
        if (!pipeline) {
            return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
        }

        if (status === "active") {
            const activationError = validateForActivation(pipeline);
            if (activationError) {
                return NextResponse.json({ error: activationError }, { status: 422 });
            }
        }

        const [updated] = await db.update(pipelines).set({
            status,
            updatedAt: new Date(),
            ...(status === "retired" ? { deletedAt: new Date() } : {}),
        }).where(eq(pipelines.id, pipeline.id)).returning();

        return NextResponse.json({ pipeline: updated });
    } catch (error) {
        console.error("Pipeline PATCH error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

// DELETE /api/pipelines/[id] - soft-delete a registry entry from the operator UI.
export async function DELETE(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const auth = await getMembership();
        if (auth.error) return auth.error;
        const membership = auth.membership;
        const { id } = await params;

        const [pipeline] = await db.select().from(pipelines).where(
            and(eq(pipelines.id, id), eq(pipelines.companyId, membership.companyId), isNull(pipelines.deletedAt))
        ).limit(1);
        if (!pipeline) {
            return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
        }

        const [deleted] = await db.update(pipelines).set({
            status: "retired",
            deletedAt: new Date(),
            updatedAt: new Date(),
        }).where(eq(pipelines.id, pipeline.id)).returning();

        return NextResponse.json({ pipeline: deleted });
    } catch (error) {
        console.error("Pipeline DELETE error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
