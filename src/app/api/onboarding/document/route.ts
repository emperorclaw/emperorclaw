import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { requireRole, AuthError } from "@/lib/roles";
import { documentationProgress, startCompanyDocumentation } from "@/lib/onboarding";

export const dynamic = "force-dynamic";

function failure(error: unknown) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    console.error("Onboarding documentation error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
}

/** Ask an agent to document the company in Knowledge & Rules: { agentId, website? }. */
export async function POST(req: NextRequest) {
    try {
        const ctx = await requireRole("owner", "admin")();
        const body = await req.json().catch(() => ({}));
        const agentId = typeof body.agentId === "string" ? body.agentId : "";
        const [agent] = agentId ? await db.select({ id: agents.id }).from(agents)
            .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agentId), isNull(agents.deletedAt))).limit(1).catch(() => []) : [];
        if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
        const website = typeof body.website === "string" && /^https?:\/\//i.test(body.website.trim()) ? body.website.trim().slice(0, 200) : null;
        const started = await startCompanyDocumentation({ companyId: ctx.companyId, agentId: agent.id, website });
        return NextResponse.json({ ...started, progress: await documentationProgress(ctx.companyId, started.taskId) }, { status: started.created ? 201 : 200 });
    } catch (error) {
        return failure(error);
    }
}

/** Progress of the documentation task: ?taskId= */
export async function GET(req: NextRequest) {
    try {
        const ctx = await requireRole("member")();
        const taskId = new URL(req.url).searchParams.get("taskId") ?? "";
        const progress = /^[0-9a-f-]{36}$/i.test(taskId) ? await documentationProgress(ctx.companyId, taskId) : null;
        if (!progress) return NextResponse.json({ error: "Task not found" }, { status: 404 });
        return NextResponse.json({ progress });
    } catch (error) {
        return failure(error);
    }
}
