import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { incidents, tasks } from "@/db/schema";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse, logAudit } from "@/lib/mcp";
import { eq, and } from "drizzle-orm";
import { notifyIncident } from "@/lib/notifications";

export async function POST(req: NextRequest) {
    const authResult = await verifyMcpToken(req);
    if ('error' in authResult) {
        return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const { companyToken } = authResult;
    const companyId = companyToken.companyId;

    const idempotencyResult = await checkIdempotency(req, companyId, "/api/mcp/incidents");
    if ('error' in idempotencyResult) {
        return NextResponse.json({ error: idempotencyResult.error }, { status: idempotencyResult.status });
    }
    if ('cachedResponse' in idempotencyResult) {
        return NextResponse.json(idempotencyResult.cachedResponse);
    }
    const { requestHash } = idempotencyResult;

    try {
        const body = await req.json();
        const { severity, reasonCode, summary, taskId, projectId, recommendedActionJson } = body;

        if (!severity || !reasonCode || !summary) {
            return NextResponse.json({ error: "Missing required fields (severity, reasonCode, summary)" }, { status: 400 });
        }

        let resolvedProjectId = projectId;

        // If no projectId provided but taskId is, lookup the projectId
        if (!resolvedProjectId && taskId) {
            const [taskRecord] = await db.select({ projectId: tasks.projectId })
                .from(tasks)
                .where(and(eq(tasks.id, taskId), eq(tasks.companyId, companyId)))
                .limit(1);

            if (taskRecord) {
                resolvedProjectId = taskRecord.projectId;
            } else {
                return NextResponse.json({ error: `Task ${taskId} not found or inaccessible` }, { status: 404 });
            }
        }

        if (!resolvedProjectId) {
            return NextResponse.json({ error: "Missing projectId (must be provided directly or inferred via taskId)" }, { status: 400 });
        }

        const [incident] = await db.insert(incidents).values({
            companyId,
            projectId: resolvedProjectId,
            taskId: taskId || null,
            severity,
            reasonCode,
            summary,
            recommendedActionJson: recommendedActionJson || null,
            status: "open"
        }).returning();

        await logAudit(companyId, "agent", null, "create_incident", "incident", incident.id, { reasonCode, severity });
        await notifyIncident(companyId, incident);

        const responseObj = { message: "Incident logged successfully", incident };
        await saveIdempotencyResponse(companyId, "/api/mcp/incidents", requestHash, responseObj);

        return NextResponse.json(responseObj, { status: 201 });
    } catch (e: any) {
        console.error("MCP Incidents Error:", e);
        return NextResponse.json({ error: "Internal server error", details: e.message }, { status: 500 });
    }
}
