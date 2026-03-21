import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { createTaskForProject } from "@/lib/openclaw/tasks";

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const endpoint = "/api/mcp/tasks/generate";

    const { requestHash, cachedResponse, error: idempError, status } = await checkIdempotency(req, companyId, endpoint);
    if (idempError) return NextResponse.json({ error: idempError }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    const body = await req.json();
    const {
        projectId,
        taskType,
        templateVersion,
        contractVersion,
        inputJson,
        priority = 0,
        proofRequired = false,
        humanApprovalRequired,
        proofTypesJson = "[]",
        blockedByTaskIds = [],
        taskKind = "standard",
        recurringTaskDefinitionId = null,
    } = body;

    if (!projectId || !taskType) {
        return NextResponse.json({ error: "projectId and taskType are required" }, { status: 400 });
    }

    try {
        const { task } = await createTaskForProject({
            companyId,
            projectId,
            recurringTaskDefinitionId,
            taskKind,
            taskType,
            templateVersion,
            contractVersion,
            inputJson,
            priority,
            proofRequired,
            humanApprovalRequired,
            proofTypesJson,
            blockedByTaskIds,
            source: "mcp_api",
        });

        const res = { message: "Task generated", task };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 201 });
    } catch (dbError) {
        if (dbError instanceof Error && dbError.message === "RELATIONSHIP_VIOLATION") {
            return NextResponse.json({ error: "RELATIONSHIP_VIOLATION", details: "projectId does not exist or belong to this company" }, { status: 400 });
        }
        console.error("DB Error:", dbError);
        return NextResponse.json({ error: "Failed to generate task" }, { status: 500 });
    }
}
