import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { finalizeTaskForAgent } from "@/lib/openclaw/tasks";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const resolvedParams = await params;
    const companyId = auth.companyToken!.companyId;
    const taskId = resolvedParams.id;
    const endpoint = `/api/mcp/tasks/${taskId}/result`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    const body = await req.json();
    const { state, outputJson, agentId, comment, approvalRationale, confidence = 0 } = body;

    if (!state || !agentId) {
        return NextResponse.json({ error: "state and agentId are required" }, { status: 400 });
    }

    try {
        const result = await finalizeTaskForAgent({
            companyId,
            taskId,
            agentId,
            state,
            outputJson,
            comment,
            approvalRationale,
            confidence,
        });

        if ("error" in result) {
            const payload = result.approval
                ? { error: result.error, approval: result.approval }
                : { error: result.error };
            return NextResponse.json(payload, { status: result.status });
        }

        const res = { message: "Task result saved", task: result.task };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res);
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        const status = message.startsWith("Agent not found") ? 404 : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
