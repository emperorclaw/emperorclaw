import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { acquireTaskLease, releaseTaskLease, type LeasedTaskRow } from "@/lib/openclaw/tasks";
import { serializeTaskWithAssignee } from "@/lib/task-assignee";
import { mcpMayUseTask, mcpRouteAccess } from "@/lib/mcp-access";

/**
 * Task lease: the mutex between sessions that share one agent.
 *
 *   POST   /api/mcp/tasks/{id}/lease   { owner?, ttlSeconds?, takeover? , agentId? }
 *   DELETE /api/mcp/tasks/{id}/lease?owner=<session id>&agentId=<agent>
 *
 * The lease is taken with one conditional UPDATE, so a second session gets 409
 * with the current holder instead of a lease it does not own. `owner` is the
 * session identity (a runtime/session id): the agent id alone cannot tell two
 * sessions of the same agent apart.
 */

type LeaseOutcome = { status: number; body: Record<string, unknown> };

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: taskId } = await params;
    const endpoint = `/api/mcp/tasks/${taskId}/lease`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const body = await req.json().catch(() => ({}));
        const scoped = await mcpRouteAccess(companyId, auth.companyToken!, body.agentId);
        if (scoped.response) return scoped.response;
        if (!(await mcpMayUseTask(companyId, scoped.access, taskId))) {
            return NextResponse.json({ error: "Task not found" }, { status: 404 });
        }
        const agentId = scoped.access.agentId;
        if (!agentId) {
            return NextResponse.json({ error: "agentId is required" }, { status: 400 });
        }

        const result = await acquireTaskLease({
            companyId,
            taskId,
            agentId,
            owner: typeof body.owner === "string" ? body.owner : null,
            ttlSeconds: typeof body.ttlSeconds === "number" ? body.ttlSeconds : null,
            takeover: body.takeover === true,
        });

        const outcome = toResponse(result, "Task lease acquired");
        if (outcome.status !== 200) {
            return NextResponse.json(outcome.body, { status: outcome.status });
        }
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, outcome.body);
        return NextResponse.json(outcome.body, { status: 200 });
    } catch (err) {
        const message = err instanceof Error ? err.message : "Internal Server Error";
        const routeStatus = message.startsWith("Agent not found") ? 404 : 500;
        return NextResponse.json({ error: message }, { status: routeStatus });
    }
}

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: taskId } = await params;
    const endpoint = `/api/mcp/tasks/${taskId}/lease`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const agentIdParam = req.nextUrl.searchParams.get("agentId");
        const scoped = await mcpRouteAccess(companyId, auth.companyToken!, agentIdParam);
        if (scoped.response) return scoped.response;
        if (!(await mcpMayUseTask(companyId, scoped.access, taskId))) {
            return NextResponse.json({ error: "Task not found" }, { status: 404 });
        }
        const agentId = scoped.access.agentId;
        if (!agentId) {
            return NextResponse.json({ error: "agentId is required" }, { status: 400 });
        }

        const result = await releaseTaskLease({
            companyId,
            taskId,
            agentId,
            owner: req.nextUrl.searchParams.get("owner"),
        });

        const outcome = toResponse(result, "Task lease released");
        if (outcome.status !== 200) {
            return NextResponse.json(outcome.body, { status: outcome.status });
        }
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, outcome.body);
        return NextResponse.json(outcome.body, { status: 200 });
    } catch (err) {
        const message = err instanceof Error ? err.message : "Internal Server Error";
        const routeStatus = message.startsWith("Agent not found") ? 404 : 500;
        return NextResponse.json({ error: message }, { status: routeStatus });
    }
}

function toResponse(
    result: { task: LeasedTaskRow; lease?: { owner: string; until: Date | null; ttlSeconds: number } }
        | { status: 403 | 404 | 409; error: string; leaseOwner?: string | null; leaseUntil?: Date | null },
    message: string,
): LeaseOutcome {
    if ("error" in result) {
        return {
            status: result.status,
            body: {
                error: result.error,
                ...(result.leaseOwner !== undefined ? { leaseOwner: result.leaseOwner } : {}),
                ...(result.leaseUntil !== undefined ? { leaseUntil: result.leaseUntil } : {}),
            },
        };
    }
    const task = serializeTaskWithAssignee(result.task);
    return {
        status: 200,
        body: {
            message,
            task,
            lease: result.lease ?? { owner: task.leaseOwner ?? null, until: task.leaseUntil ?? null },
        },
    };
}
