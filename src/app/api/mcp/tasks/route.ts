import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { getPendingApprovalSummaryForTaskIds } from "@/lib/project-workflow";
import { createTaskForProject, listTasksForCompany } from "@/lib/openclaw/tasks";

export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 500);
    const stateParam = searchParams.get("state");
    const projectId = searchParams.get("projectId");

    try {
        const rows = await listTasksForCompany({
            companyId,
            limit,
            state: stateParam,
            projectId,
        });

        const approvalSummary = await getPendingApprovalSummaryForTaskIds(
            companyId,
            rows.map((task) => task.id),
        );

        return NextResponse.json({
            tasks: rows.map((task) => {
                const summary = approvalSummary.get(task.id);
                return {
                    ...task,
                    approvalSummary: {
                        total: summary?.total || 0,
                        pending: summary?.pending || 0,
                        latestPendingApprovalId: summary?.latestApprovalId || null,
                    },
                };
            }),
        });
    } catch (err) {
        if (err instanceof Error && err.message === "Invalid state") {
            return NextResponse.json({ error: "Invalid state" }, { status: 400 });
        }
        console.error("Error fetching tasks:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const endpoint = "/api/mcp/tasks";

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
        title,
        description,
        acceptanceCriteria,
        definitionOfDone,
        deliverables,
        blockedReason,
        goal,
        ownerRole,
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
            inputJson: {
                ...(inputJson && typeof inputJson === "object" ? inputJson : {}),
                ...(title ? { title } : {}),
                ...(description ? { description } : {}),
                ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
                ...(definitionOfDone ? { definitionOfDone } : {}),
                ...(deliverables !== undefined ? { deliverables } : {}),
                ...(blockedReason ? { blockedReason } : {}),
                ...(goal ? { goal } : {}),
                ...(ownerRole ? { ownerRole } : {}),
            },
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
