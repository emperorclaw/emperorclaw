import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { getPendingApprovalSummaryForTaskIds } from "@/lib/project-workflow";
import { createTaskForProject, listTasksForCompany } from "@/lib/openclaw/tasks";
import { getTaskSpecValidationErrors } from "@/lib/openclaw/task-spec";
import { parseJsonBody, optionalString } from "@/lib/validation";

const createTaskSchema = z.object({
    projectId: z.string().min(1, "projectId is required"),
    taskType: z.string().min(1, "taskType is required"),
    templateVersion: optionalString,
    contractVersion: optionalString,
    inputJson: z.record(z.string(), z.unknown()).nullish(),
    title: optionalString,
    description: optionalString,
    acceptanceCriteria: z.unknown().optional(),
    definitionOfDone: z.unknown().optional(),
    deliverables: z.unknown().optional(),
    blockedReason: optionalString,
    goal: optionalString,
    ownerRole: optionalString,
    priority: z.number().int().default(0),
    proofRequired: z.boolean().default(false),
    humanApprovalRequired: z.boolean().nullish(),
    proofTypesJson: z.union([z.string(), z.array(z.unknown())]).default("[]"),
    blockedByTaskIds: z.array(z.string()).default([]),
    taskKind: z.string().default("standard"),
    recurringTaskDefinitionId: optionalString.default(null),
    allowUnderspecified: z.boolean().default(false),
}).loose();

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

    const parsed = await parseJsonBody(req, createTaskSchema);
    if (parsed.error !== undefined) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
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
        priority,
        proofRequired,
        humanApprovalRequired,
        proofTypesJson,
        blockedByTaskIds,
        taskKind,
        recurringTaskDefinitionId,
        allowUnderspecified,
    } = parsed.data;

    const inputPayload = {
        ...(inputJson && typeof inputJson === "object" ? inputJson : {}),
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
        ...(definitionOfDone ? { definitionOfDone } : {}),
        ...(deliverables !== undefined ? { deliverables } : {}),
        ...(blockedReason ? { blockedReason } : {}),
        ...(goal ? { goal } : {}),
        ...(ownerRole ? { ownerRole } : {}),
    };

    if (!allowUnderspecified) {
        const validationErrors = getTaskSpecValidationErrors({
            taskType,
            inputJson: inputPayload,
        });
        if (validationErrors.length > 0) {
            return NextResponse.json({
                error: "TASK_SPEC_UNDERSPECIFIED",
                details: "Tasks must include a specific machine-key taskType plus title, description, acceptanceCriteria or definitionOfDone, and deliverables. Set allowUnderspecified=true only for an intentional draft placeholder.",
                missingFields: validationErrors,
            }, { status: 400 });
        }
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
            inputJson: inputPayload,
            priority,
            proofRequired,
            humanApprovalRequired: humanApprovalRequired ?? undefined,
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
