import { NextRequest } from "next/server";
import { and, eq, isNull, desc, lt, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agents, mobileCommands, tasks } from "@/db/schema";
import { mobileCompanyAccess, mobileHash, mobileIdentity } from "@/lib/mobile-auth";
import { mobileRequestContext } from "@/lib/mobile-context";
import { mobileJson, mobileError } from "@/lib/mobile-response";
import { buildAttention, attentionAccessFromGuard } from "@/lib/attention";
import { memberVisibleProjectIds } from "@/lib/member-scope";
import { listTaskAssignees, loadTaskStory, taskViewerFromGuard } from "@/lib/task-story-reads";
import { canAdmin } from "@/lib/role-matrix";
import { consumeRateLimit } from "@/lib/rate-limit";
import { approvalDecisionAccess } from "@/lib/approval-access";
import { storedActionArgs } from "@/lib/action-policy-rules";

type Handler = (req: NextRequest, params: Record<string, string>) => Promise<Response>;
// Static imports through literal dynamic import expressions keep Next's bundle
// trace complete. There is no filesystem/router lookup based on user input.
async function handler(method: string, path: string[]): Promise<Handler | null> {
    const key = `${method} ${path.join("/")}`;
    switch (key) {
        case "GET chat": return (await import("@/app/api/chat/route")).GET;
        case "POST chat": return (await import("@/app/api/chat/route")).POST;
        case "GET chat/reasoning": return (await import("@/app/api/chat/reasoning/route")).GET;
        case "GET entities": return (await import("@/app/api/ui/entities/route")).GET;
        case "GET conversations": return (await import("@/app/api/chat/threads/route")).GET;
        case "GET groups": return (await import("@/app/api/groups/route")).GET;
        case "GET views": return (await import("@/app/api/views/route")).GET;
        case "GET projects": return (await import("@/app/api/projects/route")).GET;
        case "POST tasks": return (await import("@/app/api/tasks/route")).POST;
        case "GET approvals": return (await import("@/app/api/approvals/route")).GET;
        case "GET notifications": return (await import("@/app/api/notifications/route")).GET;
        case "POST notifications/read": return (await import("@/app/api/notifications/read/route")).POST;
        case "POST inbox/state": return (await import("@/app/api/inbox/state/route")).POST;
        case "POST attachments": return (await import("@/app/api/chat/attachments/route")).POST;
    }
    if (path.length === 2 && /^[0-9a-f-]{36}$/i.test(path[1])) {
        if (path[0] === "views" && method === "GET") return async (r) => (await import("@/app/api/views/[id]/route")).GET(r, { params: Promise.resolve({ id: path[1] }) });
        if (path[0] === "approvals" && method === "GET") return async (r) => (await import("@/app/api/approvals/[id]/route")).GET(r, { params: Promise.resolve({ id: path[1] }) });
        if (path[0] === "approvals" && method === "PATCH") return async (r) => (await import("@/app/api/approvals/[id]/route")).PATCH(r, { params: Promise.resolve({ id: path[1] }) });
        if (path[0] === "tasks" && method === "PATCH") return async (r) => (await import("@/app/api/tasks/[id]/route")).PATCH(r, { params: Promise.resolve({ id: path[1] }) });
    }
    if (path.length === 3 && /^[0-9a-f-]{36}$/i.test(path[1])) {
        if (path[0] === "runs" && path[2] === "events" && method === "GET") return async (r) => (await import("@/app/api/runs/[runId]/events/route")).GET(r, { params: Promise.resolve({ runId: path[1] }) });
        if (path[0] === "tasks" && path[2] === "notes" && method === "POST") return async (r) => (await import("@/app/api/tasks/[id]/notes/route")).POST(r, { params: Promise.resolve({ id: path[1] }) });
        if (path[0] === "agents" && path[2] === "control" && method === "POST") return async (r) => (await import("@/app/api/agents/[id]/control/route")).POST(r, { params: Promise.resolve({ id: path[1] }) });
        if (path[0] === "agents" && path[2] === "pause" && method === "PATCH") return async (r) => {
            const body = await r.json();
            if (typeof body.paused !== "boolean") return mobileJson({ error: "paused must be boolean" }, 400);
            const narrowed = new NextRequest(r.url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ budgetStatus: body.paused ? "paused" : "active" }) });
            return (await import("@/app/api/agents/[id]/route")).PATCH(narrowed, { params: Promise.resolve({ id: path[1] }) });
        };
        if (path[0] === "artifacts" && path[2] === "download" && method === "GET") return async (r) => (await import("@/app/api/ui/artifacts/[id]/download/route")).GET(r, { params: Promise.resolve({ id: path[1] }) });
    }
    return null;
}

export async function mobileWork(request: NextRequest, companyId: string, path: string[]) {
    try {
        const ctx = await mobileCompanyAccess(request, companyId);
        const identity = await mobileIdentity(request);
        if (!consumeRateLimit({ key: `mobile:work:${identity.deviceId}`, limit: 180, windowMs: 60_000 }).allowed) return mobileJson({ error: "Too many requests" }, 429);
        return await mobileRequestContext.run({ ctx, sessionId: identity.sessionId }, async () => {
            if (request.method === "GET" && path.length === 2 && path[0] === "approvals" && /^[0-9a-f-]{36}$/i.test(path[1])) {
                const access = await approvalDecisionAccess(ctx, path[1]);
                if (!access.detail || !access.view?.visible) return mobileJson({ error: "Approval not found" }, 404);
                if (access.view.mayReadDetails) return mobileJson({ ...access.detail, mobileDecision: {
                    mayDecide: access.view.mayDecide,
                    watchEligible: access.detail.approval.actionType === "task_done" && access.detail.tasks.length === 1 && (access.detail.approval.rationale?.length ?? 0) <= 300 && storedActionArgs(access.detail.approval.metadataJson).length === 0,
                    args: storedActionArgs(access.detail.approval.metadataJson),
                } });
            }
            if (request.method === "GET" && path.join("/") === "inbox") {
                const result = await buildAttention(companyId, attentionAccessFromGuard(ctx));
                return mobileJson(result);
            }
            if (request.method === "GET" && path.join("/") === "tasks") {
                const projects = await memberVisibleProjectIds(companyId, ctx.scope);
                const before = request.nextUrl.searchParams.get("before");
                const beforeDate = before ? new Date(before) : null;
                const filter = projects === null ? undefined : projects.size ? inArray(tasks.projectId, [...projects]) : eq(tasks.id, "00000000-0000-0000-0000-000000000000");
                const rows = await db.select().from(tasks).where(and(eq(tasks.companyId, companyId), isNull(tasks.deletedAt), filter,
                    beforeDate && !isNaN(beforeDate.getTime()) ? lt(tasks.createdAt, beforeDate) : undefined)).orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(101);
                return mobileJson({ tasks: rows.slice(0, 100).map((task) => ({ ...task, title: (task.inputJson as { title?: string })?.title || task.taskType })), hasMore: rows.length > 100, nextBefore: rows.length > 100 ? rows[99].createdAt.toISOString() : null });
            }
            if (request.method === "GET" && path.join("/") === "assignees") {
                return mobileJson(await listTaskAssignees(companyId, await taskViewerFromGuard(ctx)));
            }
            if (request.method === "GET" && path.length === 2 && path[0] === "tasks" && /^[0-9a-f-]{36}$/i.test(path[1])) {
                const story = await loadTaskStory(companyId, path[1], await taskViewerFromGuard(ctx), { before: request.nextUrl.searchParams.get("before") });
                return story ? mobileJson(story) : mobileJson({ error: "Task not found" }, 404);
            }
            if (request.method === "GET" && path.join("/") === "spending") {
                if (!canAdmin(ctx.role)) return mobileJson({ error: "Forbidden" }, 403);
                const rows = await db.select({ cost: agents.monthlyCostCents, budget: agents.monthlyBudgetCents }).from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)));
                return mobileJson({ costCents: rows.reduce((n, row) => n + row.cost, 0), budgetCents: rows.reduce((n, row) => n + row.budget, 0), currency: "USD", period: "month", estimated: true });
            }
            const route = await handler(request.method, path);
            if (!route) return mobileJson({ error: "Unsupported mobile operation" }, 404);
            if (request.method === "GET") {
                const result = await route(request, {});
                result.headers.set("Cache-Control", "no-store"); return result;
            }
            const key = request.headers.get("Idempotency-Key");
            if (!key || !/^[0-9a-f-]{36}$/i.test(key)) return mobileJson({ error: "A UUID Idempotency-Key is required" }, 400);
            const raw = new Uint8Array(await request.clone().arrayBuffer());
            if (raw.byteLength > 26 * 1024 * 1024) return mobileJson({ error: "Request too large" }, 413);
            const hash = mobileHash(`${request.method}:${companyId}:${path.join("/")}:${request.nextUrl.search}:${Buffer.from(raw).toString("base64")}`);
            // Claim before executing. A process crash leaves an uncertain
            // outcome and prevents automatic replay of a consequential action.
            const inserted = await db.insert(mobileCommands).values({ id: key, userId: ctx.userId, companyId, requestHash: hash }).onConflictDoNothing().returning();
            if (!inserted.length) {
                const [old] = await db.select().from(mobileCommands).where(and(eq(mobileCommands.id, key), eq(mobileCommands.userId, ctx.userId), eq(mobileCommands.companyId, companyId)));
                if (!old || old.requestHash !== hash) return mobileJson({ error: "Idempotency key conflict" }, 409);
                // A replay must never bypass newly reduced resource permissions.
                // Return only acknowledgement, not the saved sensitive payload.
                return mobileJson({ replayed: true, outcome: old.status === null ? "unknown" : "recorded", originalStatus: old.status }, old.status === null ? 409 : 200);
            }
            try {
                const response = await route(request, {});
                await db.update(mobileCommands).set({ status: response.status }).where(eq(mobileCommands.id, key));
                response.headers.set("Cache-Control", "no-store"); return response;
            } catch (error) {
                // Do not clear the claim: a side effect may already have happened.
                return mobileError(error);
            }
        });
    } catch (error) { return mobileError(error); }
}
